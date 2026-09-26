import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react';
import type { UserQuestionAnswer, UserQuestionBatch } from '../types/vulcan';

export function QuestionToolPanel({
  batch,
  onResolve,
}: {
  batch: UserQuestionBatch;
  onResolve: (answers: Record<string, UserQuestionAnswer>) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, UserQuestionAnswer>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setCustomValues({});
  }, [batch.id]);

  const question = batch.questions[index];
  if (!question) return null;

  const completeWith = (answer: UserQuestionAnswer) => {
    const next = { ...answers, [question.toolCallId]: answer };
    setAnswers(next);
    if (Object.keys(next).length >= batch.questions.length) {
      onResolve(next);
      return;
    }
    const nextUnanswered = batch.questions.findIndex((q, i) => i > index && !next[q.toolCallId]);
    if (nextUnanswered >= 0) setIndex(nextUnanswered);
    else {
      const anyUnanswered = batch.questions.findIndex((q) => !next[q.toolCallId]);
      if (anyUnanswered >= 0) setIndex(anyUnanswered);
    }
  };

  const selected = answers[question.toolCallId];
  const customValue = customValues[question.toolCallId] ?? (selected?.source === 'custom' ? selected.answer ?? '' : '');

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-ash-700 bg-ash-800/95 shadow-lg">
      <div className="flex items-start justify-between gap-4 px-3.5 pt-3 pb-2">
        <div className="min-w-0 text-[13px] leading-5 font-medium text-ash-100">
          {question.question}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-ash-500">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded p-0.5 hover:bg-ash-700 hover:text-ash-200 disabled:opacity-25"
            title="Previous question"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[42px] text-center">{index + 1} of {batch.questions.length}</span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(batch.questions.length - 1, i + 1))}
            disabled={index === batch.questions.length - 1}
            className="rounded p-0.5 hover:bg-ash-700 hover:text-ash-200 disabled:opacity-25"
            title="Next question"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const skipped = Object.fromEntries(batch.questions.map((q) => [q.toolCallId, answers[q.toolCallId] ?? { status: 'skipped' }]));
              onResolve(skipped);
            }}
            className="ml-1 rounded p-0.5 hover:bg-ash-700 hover:text-ash-200"
            title="Skip remaining questions"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-2 pb-1.5">
        {question.options.slice(0, 5).map((option, optionIndex) => {
          const isSelected = selected?.source === 'option' && selected.option_index === optionIndex;
          return (
            <button
              key={optionIndex}
              type="button"
              onClick={() => completeWith({ status: 'answered', answer: option, source: 'option', option_index: optionIndex })}
              className={`grid w-full grid-cols-[28px_minmax(0,1fr)_18px] items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${isSelected ? 'bg-ash-700' : 'hover:bg-ash-700/70'}`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ash-700 text-[11px] text-ash-200">
                {optionIndex + 1}
              </span>
              <span className="min-w-0 pt-0.5 text-[12px] leading-[1.45] text-ash-300 whitespace-normal break-words">
                {option}
              </span>
              <span className="pt-0.5 text-sm text-ash-500">{isSelected ? '→' : ''}</span>
            </button>
          );
        })}

        <div className="mt-1 grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5 border-t border-ash-700/70 px-2 pt-2 pb-1">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ash-700 text-ash-400">
            <Pencil className="h-3 w-3" />
          </span>
          <input
            type="text"
            value={customValue}
            onChange={(e) => {
              const value = e.target.value;
              setCustomValues((prev) => ({ ...prev, [question.toolCallId]: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const value = customValue.trim();
                if (value) completeWith({ status: 'answered', answer: value, source: 'custom' });
              }
            }}
            placeholder="Something else..."
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[12px] text-ash-200 outline-none placeholder:text-ash-500 focus:border-ash-600 focus:bg-ash-900/50"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-3.5 pb-2.5 pt-0.5 text-[10px] text-ash-600">
        <span>↑↓ navigate · Enter to select · or type below</span>
        <button
          type="button"
          onClick={() => completeWith({ status: 'skipped' })}
          className="rounded-md border border-ash-700 bg-ash-800 px-2 py-1 text-[11px] text-ash-300 hover:bg-ash-700"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
