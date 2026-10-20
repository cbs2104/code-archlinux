import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { logFile } from './paths'

type Level = 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 2 * 1024 * 1024

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

class Logger {
  private file: string | null = null

  init(): void {
    this.file = logFile()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (existsSync(this.file) && statSync(this.file).size > MAX_LOG_BYTES) {
        renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      this.file = null
    }
  }

  private write(level: Level, args: unknown[]): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.map(format).join(' ')}\n`
    if (level === 'error') console.error(line.trimEnd())
    else if (level === 'warn') console.warn(line.trimEnd())
    else console.log(line.trimEnd())
    if (!this.file) return
    try {
      appendFileSync(this.file, line)
    } catch {
      /* logging must never break the app */
    }
  }

  info(...args: unknown[]): void {
    this.write('info', args)
  }

  warn(...args: unknown[]): void {
    this.write('warn', args)
  }

  error(...args: unknown[]): void {
    this.write('error', args)
  }
}

export const log = new Logger()
