import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy } from 'lucide-react';

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm text-ash-200 prose prose-invert prose-sm max-w-none
      prose-p:leading-relaxed prose-p:my-1
      prose-headings:text-ash-100 prose-headings:font-semibold
      prose-strong:text-ash-100
      prose-code:text-purple-300 prose-code:bg-ash-800 prose-code:px-1 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
      prose-pre:p-0 prose-pre:bg-transparent prose-pre:rounded-lg
      prose-a:text-coral-400 prose-a:no-underline hover:prose-a:underline
      prose-ul:my-1 prose-ul:pl-5 prose-ol:my-1 prose-ol:pl-5 prose-li:my-0
      prose-blockquote:border-ash-600 prose-blockquote:text-ash-400
      prose-hr:border-t prose-hr:border-ash-700
      prose-table:text-xs prose-table:border-collapse
      prose-thead:border-b prose-thead:border-ash-600
      prose-tr:border-b prose-tr:border-ash-700/50
      prose-th:px-3 prose-th:py-1.5 prose-th:text-left
      prose-td:px-3 prose-td:py-1.5
    ">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        components={{
          h1: ({ children, ...props }: any) => <h1 className="text-xl font-bold text-ash-100 mt-3 mb-1" {...props}>{children}</h1>,
          h2: ({ children, ...props }: any) => <h2 className="text-lg font-semibold text-ash-100 mt-3 mb-1" {...props}>{children}</h2>,
          h3: ({ children, ...props }: any) => <h3 className="text-base font-semibold text-ash-100 mt-2 mb-1" {...props}>{children}</h3>,
          h4: ({ children, ...props }: any) => <h4 className="text-sm font-semibold text-ash-200 mt-2 mb-0.5" {...props}>{children}</h4>,
          h5: ({ children, ...props }: any) => <h5 className="text-xs font-semibold uppercase tracking-wide text-ash-300 mt-2 mb-0.5" {...props}>{children}</h5>,
          h6: ({ children, ...props }: any) => <h6 className="text-xs font-medium uppercase tracking-wider text-ash-400 mt-2 mb-0.5" {...props}>{children}</h6>,
          code({ className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeStr = String(children).replace(/\n$/, '');
            if (match) {
              return (
                <div className="relative group rounded-lg overflow-hidden my-2">
                  <div className="flex items-center justify-between px-3 py-1 bg-ash-700/60 text-xs text-ash-400 font-mono">
                    <span>{match[1]}</span>
                    <button onClick={() => navigator.clipboard.writeText(codeStr)} className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-ash-200">
                      <Copy className="w-3 h-3" />copy
                    </button>
                  </div>
                  <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div" customStyle={{ margin: 0, borderRadius: 0, fontSize: '0.75rem' }}>
                    {codeStr}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return <code className={className} {...props}>{children}</code>;
          },
          ul: ({ children, ...props }: any) => <ul className="list-disc pl-5 my-1 [&_ul]:list-[circle] [&_ul_ul]:list-[square]" {...props}>{children}</ul>,
          ol: ({ children, ...props }: any) => <ol className="list-decimal pl-5 my-1 [&_ol]:list-[lower-alpha]" {...props}>{children}</ol>,
          a: ({ children, href, ...props }: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-coral-400 underline underline-offset-2 hover:text-coral-300 transition-colors" {...props}>{children}</a>,
          blockquote: ({ children, ...props }: any) => <blockquote className="border-l-2 border-ash-700 pl-3 my-2 text-ash-400 italic" {...props}>{children}</blockquote>,
          table: ({ children, ...props }: any) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-ash-700 text-xs w-full" {...props}>{children}</table></div>,
          th: ({ children, ...props }: any) => <th className="border border-ash-600 px-3 py-1.5 bg-ash-800 text-ash-200 font-semibold text-left" {...props}>{children}</th>,
          td: ({ children, ...props }: any) => <td className="border border-ash-700 px-3 py-1.5 text-ash-300" {...props}>{children}</td>,
          input: ({ ...props }) => <input {...props} className="mr-1.5 accent-blue-500" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
