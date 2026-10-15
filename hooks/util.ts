// Small helpers every part of the mod uses.

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

// JSON for $.state: no undefined anywhere.
export const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// JSON with every object's keys in order, so two copies of one map compare equal.
export const canon = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  )

export const cleanRoot = (root: unknown) =>
  typeof root === 'string' ? root.trim().replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/(^|\/)\.\.(\/|$)/g, '') : ''

export const inRoot = (root: string, path: string) => (root ? `${root}/${path}` : path)
