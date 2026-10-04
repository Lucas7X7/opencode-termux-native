import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'

export interface DownloadOptions {
  token?: string
  onProgress?: (received: number, total: number) => void
}

/**
 * Fetch straight to disk with Node's own HTTP stack, so no `curl` is required.
 * The write is atomic: a dropped connection leaves a `.part` file behind, never
 * a half-written release that a later run would happily checksum-fail on.
 */
export async function download(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`

  const headers: Record<string, string> = { 'user-agent': 'opencode-termux-native' }
  if (options.token) headers.authorization = `Bearer ${options.token}`

  try {
    const response = await fetch(url, { headers, redirect: 'follow' })
    if (!response.ok || !response.body) {
      throw new Error(`download failed (${response.status}) for ${url}`)
    }

    const total = Number(response.headers.get('content-length')) || 0
    let received = 0
    const source = Readable.fromWeb(response.body as NodeReadableStream)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      options.onProgress?.(received, total)
    })

    await pipeline(source, createWriteStream(part))
    await rename(part, dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}
