use std::iter::Peekable;
use std::str::Chars;

/// Incremental UTF-8 decoder that preserves multibyte characters split across
/// read/network chunk boundaries.
///
/// Feeding raw byte chunks to `String::from_utf8_lossy` independently corrupts
/// any character (e.g. Chinese text) that straddles a chunk boundary, replacing
/// both halves with `U+FFFD`. This decoder buffers a trailing partial sequence
/// until the continuation bytes arrive.
#[derive(Default)]
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    decoded.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        decoded.push_str(
                            std::str::from_utf8(&self.pending[..valid_up_to])
                                .expect("Utf8Error valid prefix must decode"),
                        );
                        self.pending.drain(..valid_up_to);
                    }
                    match error.error_len() {
                        Some(invalid_len) => {
                            decoded.push('\u{fffd}');
                            self.pending.drain(..invalid_len);
                        }
                        None => break,
                    }
                }
            }
        }

        decoded
    }
}

/// 去掉终端字节流里的控制序列,只保留用户在屏幕上实际看到的文本。
///
/// 终端快照是 PTY 原始输出:颜色与光标控制(CSI)、标题/shell 集成标记/超链接
/// (OSC)以及 DCS 等字符串序列都会原样进入缓冲,这些字节对模型没有信息量而且
/// 分词极差。回车按覆盖语义折叠(进度条只留下最后一帧),退格删掉前一个字符,
/// 其余 C0 控制字符丢弃;`\n` 与 `\t` 保留。
pub fn strip_terminal_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut line_start = 0;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => skip_escape_sequence(&mut chars),
            '\n' => {
                output.push('\n');
                line_start = output.len();
            }
            '\r' => {
                while chars.peek() == Some(&'\r') {
                    chars.next();
                }
                // 行尾的 \r\n 只是换行;其余情况光标回到行首,后续文本覆盖本行
                if !matches!(chars.peek(), Some('\n') | None) {
                    output.truncate(line_start);
                }
            }
            '\u{8}' => {
                if output.len() > line_start {
                    output.pop();
                }
            }
            '\t' => output.push('\t'),
            ch if ch.is_control() => {}
            ch => output.push(ch),
        }
    }
    output
}

fn skip_escape_sequence(chars: &mut Peekable<Chars<'_>>) {
    // ESC 后紧跟控制字符(或已到结尾)不构成序列:丢掉 ESC,控制字符留给主循环
    let Some(&kind) = chars.peek() else { return };
    if kind.is_control() {
        return;
    }
    chars.next();
    match kind {
        // CSI:参数字节 0x30–0x3F 与中间字节 0x20–0x2F 之后是一个终止字节 0x40–0x7E;
        // 遇到序列之外的字符视为序列损坏,停下并把该字符留给正文
        '[' => {
            while let Some(&next) = chars.peek() {
                if !('\u{20}'..='\u{7e}').contains(&next) {
                    break;
                }
                chars.next();
                if ('\u{40}'..='\u{7e}').contains(&next) {
                    break;
                }
            }
        }
        // OSC / DCS / SOS / PM / APC:到 BEL 或 ST(ESC \)为止。正文里不会出现换行,
        // 碰到换行说明序列被截断,停下并保留换行
        ']' | 'P' | 'X' | '^' | '_' => {
            while let Some(&next) = chars.peek() {
                if next == '\n' {
                    break;
                }
                chars.next();
                if next == '\u{7}' {
                    break;
                }
                if next == '\u{1b}' {
                    if chars.peek() == Some(&'\\') {
                        chars.next();
                    } else {
                        skip_escape_sequence(chars);
                    }
                    break;
                }
            }
        }
        // 带中间字节的转义(如字符集指定 ESC ( B):中间字节之后还有一个终止字节
        kind if ('\u{20}'..='\u{2f}').contains(&kind) => {
            while let Some(&next) = chars.peek() {
                chars.next();
                if !('\u{20}'..='\u{2f}').contains(&next) {
                    break;
                }
            }
        }
        // 两字节转义(ESC 7、ESC =、ESC M 等):kind 本身就是终止字节
        _ => {}
    }
}

#[cfg(test)]
mod strip_terminal_control_sequences_tests {
    use super::strip_terminal_control_sequences as strip;

    #[test]
    fn removes_colors_modes_and_cursor_controls() {
        assert_eq!(
            strip("\u{1b}[32mok\u{1b}[0m \u{1b}[1;38;5;208mwarn\u{1b}[m"),
            "ok warn"
        );
        assert_eq!(
            strip("\u{1b}[?25l\u{1b}[?2004h\u{1b}[2J\u{1b}[H\u{1b}[3;1Htext\u{1b}[?25h"),
            "text"
        );
        assert_eq!(strip("\u{1b}[38:2:255:0:0mrgb\u{1b}[0m"), "rgb");
    }

    #[test]
    fn removes_osc_strings_with_either_terminator_and_keeps_link_text() {
        assert_eq!(
            strip("\u{1b}]0;host: ~\u{7}\u{1b}]133;A\u{1b}\\$ ls"),
            "$ ls"
        );
        assert_eq!(
            strip("\u{1b}]7;file://host/home\u{1b}\\\u{1b}]133;B\u{7}"),
            ""
        );
        assert_eq!(
            strip("see \u{1b}]8;;https://example.com\u{1b}\\docs\u{1b}]8;;\u{1b}\\ now"),
            "see docs now"
        );
        assert_eq!(
            strip("\u{1b}Pq#0;2;0;0;0\u{1b}\\x\u{1b}_payload\u{7}y"),
            "xy"
        );
    }

    #[test]
    fn removes_two_byte_and_intermediate_escapes() {
        assert_eq!(
            strip("\u{1b}(B\u{1b})0\u{1b}=\u{1b}7text\u{1b}8\u{1b}M"),
            "text"
        );
        assert_eq!(strip("\u{1b}#8grid"), "grid");
    }

    #[test]
    fn collapses_carriage_return_overwrites_but_keeps_line_endings() {
        assert_eq!(strip("a\r\nb\r\r\nc"), "a\nb\nc");
        assert_eq!(strip("10%\r50%\r100%\r\ndone"), "100%\ndone");
        assert_eq!(strip("old line\r\u{1b}[Knew\n"), "new\n");
        // 快照结尾的回车还没有被覆盖:最后一帧要留下
        assert_eq!(strip("10%\r45%\r"), "45%");
        assert_eq!(strip("\rprompt$ "), "prompt$ ");
    }

    #[test]
    fn applies_backspace_and_drops_other_control_characters() {
        assert_eq!(strip("lss\u{8} \u{8}\n"), "ls\n");
        assert_eq!(strip("\u{8}\u{8}x"), "x");
        assert_eq!(strip("a\tb\u{7}\u{0}\u{f}c\u{7f}"), "a\tbc");
    }

    #[test]
    fn stops_at_malformed_or_truncated_sequences_without_eating_text() {
        assert_eq!(strip("\u{1b}[中文"), "中文");
        assert_eq!(strip("\u{1b}]0;cut off\nnext"), "\nnext");
        assert_eq!(strip("text\u{1b}"), "text");
        assert_eq!(strip("a\u{1b}\nb"), "a\nb");
        assert_eq!(strip("\u{1b}]0;title\u{1b}[31mred"), "red");
    }

    #[test]
    fn leaves_plain_multilingual_text_untouched() {
        let text = "总用量 12\ndrwxr-xr-x  2 root root 4096 9月  1 10:00 logs\n";
        assert_eq!(strip(text), text);
    }
}

#[cfg(test)]
mod utf8_stream_decoder_tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn preserves_multibyte_terminal_text_split_across_reads() {
        let text = "\u{001b}[32m请选择资产分类\u{001b}[0m";
        let bytes = text.as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut decoder = Utf8StreamDecoder::default();

        let first = decoder.push(&bytes[..split]);
        let second = decoder.push(&bytes[split..]);

        assert_eq!(format!("{first}{second}"), text);
        assert!(!first.contains('\u{fffd}'));
        assert!(!second.contains('\u{fffd}'));
    }

    #[test]
    fn replaces_invalid_bytes_without_discarding_following_output() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(b"ok\xffnext"), "ok\u{fffd}next");
    }
}
