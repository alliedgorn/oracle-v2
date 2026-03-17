import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './Playbook.module.css';

const API_BASE = '/api';

export function Playbook() {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/playbook`)
      .then(r => r.text())
      .then(text => { setContent(text); setLoading(false); })
      .catch(() => { setContent('# Playbook not found\n\nPlace your playbook at `/home/gorn/workspace/den-playbook.md`'); setLoading(false); });
  }, []);

  if (loading) return <div className={styles.container}><p className={styles.loading}>Loading playbook...</p></div>;

  return (
    <div className={styles.container}>
      <article className={styles.content}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const inline = !match && !String(children).includes('\n');
              return inline ? (
                <code className={styles.inlineCode} {...props}>{children}</code>
              ) : (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match?.[1] || 'bash'}
                  PreTag="div"
                  customStyle={{ margin: '12px 0', borderRadius: '8px', fontSize: '0.85em' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
