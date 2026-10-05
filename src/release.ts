export const DEFAULT_REPO = 'Lucas7X7/opencode-termux-native'
export const NATIVE_ASSET = 'opencode-termux-native-aarch64.tar.gz'
export const CHECKSUM_ASSET = 'SHA256SUMS'

export interface ReleaseAsset {
  name: string
  url: string
}

export interface Release {
  tag: string
  version: string
  assets: ReleaseAsset[]
}

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  assets?: unknown
}

export function parseRelease(raw: unknown): Release | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const data = raw as GithubRelease
  if (typeof data.tag_name !== 'string') return undefined

  const assets: ReleaseAsset[] = []
  if (Array.isArray(data.assets)) {
    for (const item of data.assets) {
      const asset = item as GithubAsset
      if (typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') {
        assets.push({ name: asset.name, url: asset.browser_download_url })
      }
    }
  }

  return { tag: data.tag_name, version: data.tag_name.replace(/^v/, ''), assets }
}

export function assetUrl(release: Release, name: string): string | undefined {
  return release.assets.find((asset) => asset.name === name)?.url
}

export function nativeTagFor(version: string): string {
  return `v${version.replace(/^v/, '')}-native`
}

function headers(token?: string): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'opencode-termux-native',
  }
  if (token) base.authorization = `Bearer ${token}`
  return base
}

async function getJson(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, { headers: headers(token), redirect: 'follow' })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`)
  return response.json()
}

export async function fetchLatestRelease(
  repo = DEFAULT_REPO,
  token = process.env.GITHUB_TOKEN,
  requireAsset?: string,
): Promise<Release> {
  const raw = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, token)
  const release = parseRelease(raw)
  if (!release) throw new Error(`no published release found for ${repo}`)
  if (!requireAsset || assetUrl(release, requireAsset)) return release

  // `/releases/latest` is whatever was created most recently, and this repo also
  // holds pinned seed releases. Without this walk, re-uploading a seed asset
  // would make `latest` point at a release with no native build in it and the
  // install would fail with a confusing "has no asset" error.
  const list = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=30`, token)
  const candidates = Array.isArray(list) ? list : []
  for (const candidate of candidates) {
    const parsed = parseRelease(candidate)
    if (parsed && assetUrl(parsed, requireAsset)) return parsed
  }
  throw new Error(`no release for ${repo} carries ${requireAsset}`)
}

export async function fetchReleaseByTag(
  tag: string,
  repo = DEFAULT_REPO,
  token = process.env.GITHUB_TOKEN,
): Promise<Release> {
  const raw = await getJson(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  )
  const release = parseRelease(raw)
  if (!release) throw new Error(`release ${tag} not found for ${repo}`)
  return release
}
