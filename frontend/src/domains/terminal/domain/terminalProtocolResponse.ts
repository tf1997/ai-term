/** xterm sends these reports through onData alongside actual keyboard input. */
export function isTerminalProtocolResponse(data: string): boolean {
  // Focus, status, cursor position, device attributes, mode and window reports.
  if (/^\x1b\[(?:[IO]|0n|\??\d+;\d+R|[?>][\d;]+c|\??\d+;\d+\$y|[468];\d+;\d+t)$/.test(data)) return true
  // Palette/foreground/background/cursor color replies (OSC 4/10/11/12).
  if (/^\x1b\](?:4;\d+|1[012]);rgb:[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}(?:\x07|\x1b\\)$/.test(data)) return true
  // DECRQSS replies: rendition, margins, cursor style, protection and conformance.
  return /^\x1bP(?:0\$r|1\$r(?:\d+m|\d+;\d+r|\d+ q|\d+"q|\d+;\d+"p))\x1b\\$/.test(data)
}
