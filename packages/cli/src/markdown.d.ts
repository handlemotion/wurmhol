// Markdown files are bundled as text (tsdown `loader`), e.g. the skill `init --skill` writes.
declare module "*.md" {
  const text: string;
  export default text;
}
