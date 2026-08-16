/**
 * `import prompt from './x.md' with { type: 'text' }`.
 *
 * Bun resolves and inlines this at build time; TypeScript needs telling that a
 * `.md` module exists at all. Declared here rather than reached for with a cast
 * at the import site, so the one prompt that ships with cutver stays a document
 * — prose wedged into a template literal is prose nobody edits.
 */
declare module '*.md' {
  const content: string
  export default content
}
