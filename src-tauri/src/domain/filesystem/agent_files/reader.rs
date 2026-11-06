use super::*;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::AtomicBool;

pub fn read_text_page<R: Read + Seek>(
    reader: &mut R,
    size: u64,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileReadPage> {
    options.validate()?;
    FileError::cancelled(cancel)?;
    if resume.is_some_and(|position| position.byte > size || position.line == Some(0)) {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "分页位置超出文件范围",
        ));
    }
    if options.tail {
        if resume.is_some() {
            return Err(FileError::new(
                FileErrorKind::InvalidRequest,
                "从末尾读取不能同时指定分页位置",
            ));
        }
        return tail_page(reader, size, options, cancel);
    }
    let initial = resume.cloned().unwrap_or(FilePosition {
        byte: 0,
        line: Some(1),
        mid_line: false,
    });
    if resume.is_some() && options.start_line != 1 {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "分页不能重新指定开始行",
        ));
    }
    reader.seek(SeekFrom::Start(initial.byte))?;
    // One extra byte distinguishes exact EOF from the scan limit. No request
    // can make a BufReader prefetch beyond this independent scan budget.
    let mut input = BufReader::with_capacity(8192, reader.take((MAX_SCAN_BYTES + 1) as u64));
    let mut position = initial.clone();
    let mut start = initial;
    let mut selected = Vec::with_capacity(options.max_bytes);
    let mut scanned = 0;
    let mut output_lines = 0;
    let mut truncation = None;
    let mut selecting = resume.is_some() || options.start_line == 1;
    while scanned < MAX_SCAN_BYTES {
        FileError::cancelled(cancel)?;
        let buffer = input.fill_buf()?;
        if buffer.is_empty() {
            break;
        }
        let mut consumed = 0;
        for &byte in buffer.iter().take(MAX_SCAN_BYTES - scanned) {
            consumed += 1;
            scanned += 1;
            if byte == 0 {
                return Err(FileError::new(
                    FileErrorKind::Binary,
                    "文件包含二进制字节，不能按 UTF-8 文本阅读",
                ));
            }
            position.byte += 1;
            position.mid_line = byte != b'\n';
            if byte == b'\n' {
                position.line = position.line.map(|line| line + 1);
            }
            if !selecting {
                start = position.clone();
                selecting = position.line.is_some_and(|line| line >= options.start_line);
                continue;
            }
            selected.push(byte);
            if byte == b'\n' {
                output_lines += 1;
            }
            if output_lines >= options.max_lines {
                truncation = Some(FileTruncation::Lines);
                break;
            }
            if selected.len() >= options.max_bytes {
                truncation = Some(FileTruncation::Bytes);
                break;
            }
        }
        input.consume(consumed);
        if truncation.is_some() {
            break;
        }
    }
    let eof = input.fill_buf()?.is_empty();
    let read_bytes = (MAX_SCAN_BYTES + 1) - input.get_ref().limit() as usize;
    if !eof && truncation.is_none() {
        truncation = Some(FileTruncation::ScanBudget);
    }
    let content = match std::str::from_utf8(&selected) {
        Ok(text) => text.to_string(),
        Err(error) if !eof && error.error_len().is_none() => {
            let valid = error.valid_up_to();
            position.byte -= (selected.len() - valid) as u64;
            selected.truncate(valid);
            String::from_utf8(selected).expect("validated UTF-8 prefix")
        }
        Err(_) => {
            return Err(FileError::new(
                FileErrorKind::UnsupportedEncoding,
                "文件不是有效的 UTF-8 文本",
            ))
        }
    };
    Ok(FileReadPage {
        complete: eof && start.byte == 0,
        content,
        start,
        end: position,
        eof,
        truncation: if eof { None } else { truncation },
        scanned_bytes: read_bytes,
    })
}

fn tail_page<R: Read + Seek>(
    reader: &mut R,
    size: u64,
    options: &FileReadOptions,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileReadPage> {
    let window_start = size.saturating_sub(options.max_bytes as u64);
    // Include a preceding byte to tell a line boundary from a partial first line.
    let read_start = window_start.saturating_sub(1);
    reader.seek(SeekFrom::Start(read_start))?;
    let mut bytes = Vec::with_capacity(options.max_bytes + 1);
    reader
        .take((size - read_start) as u64)
        .read_to_end(&mut bytes)?;
    FileError::cancelled(cancel)?;
    let scanned_bytes = bytes.len();
    if bytes.contains(&0) {
        return Err(FileError::new(FileErrorKind::Binary, "文件包含二进制字节"));
    }
    let mut begin = (window_start - read_start) as usize;
    if begin > bytes.len() {
        return Err(FileError::new(
            FileErrorKind::VersionChanged,
            "文件在读取末尾时缩短",
        ));
    }
    // A tail window may begin inside a UTF-8 scalar. Skip only continuation
    // bytes at that boundary; invalid bytes elsewhere are reported as encoding.
    if begin > 0 {
        while begin < bytes.len() && bytes[begin] & 0xc0 == 0x80 {
            begin += 1;
        }
    }
    let mut lines = 0;
    let mut line_limited = false;
    for index in (begin..bytes.len()).rev() {
        if bytes[index] == b'\n' && index + 1 < bytes.len() {
            lines += 1;
            if lines >= options.max_lines {
                begin = index + 1;
                line_limited = true;
                break;
            }
        }
    }
    let content = std::str::from_utf8(&bytes[begin..])
        .map_err(|_| {
            FileError::new(
                FileErrorKind::UnsupportedEncoding,
                "文件不是有效的 UTF-8 文本",
            )
        })?
        .to_string();
    let start_byte = read_start + begin as u64;
    let end_byte = read_start + bytes.len() as u64;
    let complete = start_byte == 0 && end_byte == size;
    Ok(FileReadPage {
        content,
        start: FilePosition {
            byte: start_byte,
            line: if start_byte == 0 { Some(1) } else { None },
            mid_line: begin > 0 && bytes[begin - 1] != b'\n',
        },
        end: FilePosition {
            byte: end_byte,
            line: None,
            mid_line: !bytes.is_empty() && bytes.last() != Some(&b'\n'),
        },
        eof: end_byte == size,
        complete,
        truncation: if complete {
            None
        } else if line_limited {
            Some(FileTruncation::Lines)
        } else {
            Some(FileTruncation::TailWindow)
        },
        scanned_bytes,
    })
}

pub fn directory_page(
    entries: impl Iterator<Item = FileResult<FileDirectoryEntry>>,
    offset: usize,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileDirectoryPage> {
    use sha2::{Digest, Sha256};
    if limit == 0 || limit > MAX_DIRECTORY_ENTRIES || offset >= MAX_DIRECTORY_SCAN {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "目录分页最多返回 500 项，最多扫描 10000 项",
        ));
    }
    let mut result = Vec::new();
    let mut scanned = 0;
    let mut bytes = 2;
    let mut next = None;
    let mut truncation = None;
    let mut prefix = Sha256::new();
    prefix.update(b"ai-term-directory-v1");
    let mut start_fingerprint = (offset == 0).then(|| format!("{:x}", prefix.clone().finalize()));
    for entry in entries.take(MAX_DIRECTORY_SCAN) {
        FileError::cancelled(cancel)?;
        let entry = entry?;
        let index = scanned;
        scanned += 1;
        if entry.name.is_empty()
            || entry.name.len() > 4096
            || entry.name.chars().any(char::is_control)
            || entry.name.contains('/')
        {
            return Err(FileError::new(
                FileErrorKind::UnsupportedEncoding,
                "目录包含无法安全表示的文件名",
            ));
        }
        let encoded = serde_json::to_vec(&entry).expect("serializable directory entry");
        if index >= offset {
            if result.len() == limit {
                next = Some(index);
                truncation = Some(FileTruncation::Lines);
                break;
            }
            let size = encoded.len() + usize::from(!result.is_empty());
            if bytes + size > MAX_FILE_BYTES {
                next = Some(index);
                truncation = Some(FileTruncation::Bytes);
                break;
            }
            bytes += size;
            result.push(entry);
        }
        prefix.update((encoded.len() as u64).to_le_bytes());
        prefix.update(encoded);
        if scanned == offset {
            start_fingerprint = Some(format!("{:x}", prefix.clone().finalize()));
        }
    }
    if scanned == MAX_DIRECTORY_SCAN && next.is_none() {
        truncation = Some(FileTruncation::ScanBudget);
    }
    let start_fingerprint = start_fingerprint.ok_or_else(|| {
        FileError::new(
            FileErrorKind::VersionChanged,
            "目录项目数量已变化，原分页位置不存在",
        )
    })?;
    Ok(FileDirectoryPage {
        entries: result,
        next_offset: next,
        scanned_entries: scanned,
        truncation,
        start_fingerprint,
        end_fingerprint: format!("{:x}", prefix.finalize()),
    })
}
