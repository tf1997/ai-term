/** Load the actual faces before xterm measures and caches its character cells. */
export async function loadTerminalFonts(
  family: string,
  size: number,
  weights: readonly string[],
  fonts: Pick<FontFaceSet, 'load'> = document.fonts
): Promise<void> {
  try {
    await Promise.all([...new Set(weights)].map(weight => fonts.load(`${weight} ${size}px ${family}`, 'W汉字')))
  } catch {
    // A failed local font asset must not prevent opening the terminal.
    // The family stack still ends in the system monospace fallback.
  }
}
