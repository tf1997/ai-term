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
