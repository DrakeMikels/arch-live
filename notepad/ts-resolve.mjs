// Lets plain Node load the mod's TypeScript modules, whose relative imports
// leave off the extension ('./journal' for './journal.ts'). Node strips the
// types itself (22.18 or newer); this only finds the files.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (!isRelative || /\.[mc]?[jt]sx?$/.test(specifier)) throw err
    for (const ext of ['.ts', '/index.ts']) {
      try {
        return await next(`${specifier}${ext}`, context)
      } catch {
        // try the next spelling
      }
    }
    throw err
  }
}
