const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const paint = (code: string, text: string): string =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text

export const bold = (text: string): string => paint('1', text)
export const dim = (text: string): string => paint('2', text)
export const cyan = (text: string): string => paint('36', text)
export const green = (text: string): string => paint('32', text)
export const red = (text: string): string => paint('31', text)
export const amber = (text: string): string => paint('33', text)

export const info = (message: string): void => console.log(`${cyan('·')} ${message}`)
export const ok = (message: string): void => console.log(`${green('✓')} ${message}`)
export const warn = (message: string): void => console.warn(`${amber('!')} ${message}`)
export const fail = (message: string): void => console.error(`${red('✗')} ${message}`)

export function bail(message: string, code = 1): never {
  fail(message)
  process.exit(code)
}
