import type { Extension } from "@codemirror/state";

/**
 * Lazily resolves the CodeMirror language extension for a server language id.
 *
 * Only languages with an installed `@codemirror/lang-*` package are mapped.
 * Every language package is loaded through a dynamic `import()` so the editor
 * bundle never eagerly includes grammars for languages the server cannot emit.
 * Unknown/unsupported ids resolve to `null`.
 */
export async function loadLanguageExtension(language: string): Promise<Extension | null> {
  switch (language) {
    case "typescript":
    case "javascript":
    // Prism (the source view) names TSX/JSX separately; CodeMirror covers both.
    case "tsx":
    case "jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true, jsx: true });
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "html":
    case "markup": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "rust": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust();
    }
    case "cpp":
    case "c": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go();
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      return php();
    }
    default:
      return null;
  }
}