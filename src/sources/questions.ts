/** Options can be plain strings or provider records carrying a display label. */
export function renderQuestionLine(question: string, options: unknown, multiple = false): string {
  if (!question.trim()) return "";
  const labels = Array.isArray(options)
    ? options.flatMap((option) => {
        const label = typeof option === "string" ? option : option?.label;
        return typeof label === "string" && label.trim() ? [label.trim()] : [];
      })
    : [];
  const choices = labels.length ? ` [${labels.join(", ")}]` : "";
  return `${question.trim()}${choices}${multiple ? " (multi-select)" : ""}`;
}

export function renderDecisionLine(question: string, answer: unknown): string {
  const values: unknown[] = Array.isArray(answer) ? answer : [answer];
  const text = values.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : []));
  return question.trim() && text.length
    ? `[decision] "${question.trim()}" → ${text.join(", ")}`
    : "";
}
