/**
 * The three shell templates, inlined at build time by Bun.
 *
 * `.jstext` rather than `.js`, and it is not arbitrary: TypeScript resolves a
 * relative `./shell.js` as a JavaScript module and tries to type its contents,
 * which for a 34 kB template full of `{{placeholders}}` is neither possible nor
 * useful. The import attribute already says `text`; the extension is what stops
 * the resolver disagreeing. Map it to JavaScript in your editor for
 * highlighting — nothing here reads it as code.
 *
 * `*.html` is absent on purpose: Bun's own types claim that wildcard for
 * `HTMLBundle` and win, which is why `index.ts` casts that one import.
 */
declare module '*.css' {
  const content: string
  export default content
}

declare module '*.jstext' {
  const content: string
  export default content
}
