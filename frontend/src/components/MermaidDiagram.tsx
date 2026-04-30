import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  // Force SVG <text> elements instead of <foreignObject> HTML. DOMPurify's
  // svg profile preserves <text> but strips <foreignObject> contents — without
  // this, node labels render invisible (boxes + arrows show, text gone).
  flowchart: { htmlLabels: false },
  themeVariables: {
    primaryColor: '#d97706',
    primaryTextColor: '#c9d1d9',
    primaryBorderColor: '#d97706',
    lineColor: '#6e7681',
    secondaryColor: '#1c2128',
    tertiaryColor: '#161b22',
    background: '#0d1117',
    mainBkg: '#161b22',
    nodeBorder: '#d97706',
    clusterBkg: '#1c2128',
    clusterBorder: '#30363d',
    titleColor: '#c9d1d9',
    edgeLabelBackground: '#161b22',
  },
});

let idCounter = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const id = `mermaid-${++idCounter}`;

    (async () => {
      try {
        const { svg } = await mermaid.render(id, code.trim());
        if (containerRef.current) {
          // Mermaid v11 still uses <foreignObject> + inline HTML (span/div) for
          // some node labels even with flowchart.htmlLabels:false. Pure svg
          // profile strips the HTML inside foreignObject → invisible labels.
          // Allow svg + the small set of HTML tags mermaid emits, plus the
          // attrs needed for class-based styling. mermaid securityLevel:strict
          // already escapes user input before it reaches the SVG, so the inner
          // HTML is mermaid-controlled.
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject', 'span', 'div', 'p', 'br'],
            ADD_ATTR: ['class', 'style', 'xmlns', 'requiredExtensions'],
          });
          setError(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to render diagram');
      }
    })();
  }, [code]);

  if (error) {
    return (
      <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13 }}>
        <p style={{ margin: '0 0 8px', color: 'var(--danger, red)' }}>Mermaid error: {error}</p>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{code}</pre>
      </div>
    );
  }

  return <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }} />;
}
