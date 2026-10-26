// Import this first, then import the TypeScript modules dynamically: static
// imports are all resolved before any module runs.
import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
