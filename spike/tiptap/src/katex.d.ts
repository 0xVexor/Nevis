declare module 'katex' {
  const katex: {
    render(latex: string, el: HTMLElement, opts?: { displayMode?: boolean; throwOnError?: boolean; output?: string }): void
  }
  export default katex
}
