// These interactions stay in the visitor's browser. No answers or values are
// sent to, or stored by, the 49Agents server.
document.addEventListener('click', (event) => {
  const option = event.target.closest('[data-poll-option], [data-quiz-option]');
  if (!option) return;

  const poll = option.closest('[data-poll]');
  if (poll) {
    for (const button of poll.querySelectorAll('[data-poll-option]')) button.disabled = true;
    const result = poll.querySelector('[data-local-result]');
    if (result) result.textContent = `Your selection: ${option.textContent.trim()}`;
    return;
  }

  const quiz = option.closest('[data-quiz]');
  if (quiz) {
    const options = [...quiz.querySelectorAll('[data-quiz-option]')];
    const selected = options.indexOf(option);
    const correct = Number(quiz.dataset.correctIndex) === selected;
    const result = quiz.querySelector('[data-local-result]');
    if (result) result.textContent = correct ? 'Correct.' : 'Try again.';
    if (correct) {
      for (const button of options) button.disabled = true;
      const explanation = quiz.querySelector('[data-quiz-explanation]');
      if (explanation) explanation.hidden = false;
    }
  }
});

document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-calc-input]');
  if (!input) return;
  const calculator = input.closest('[data-calculator]');
  const inputs = [...calculator.querySelectorAll('[data-calc-input]')];
  const values = inputs.map((item) => Number(item.value));
  const output = calculator.querySelector('[data-local-result]');
  if (!values.every(Number.isFinite)) { output.textContent = 'Enter valid numbers.'; return; }

  let result;
  switch (calculator.dataset.operation) {
    case 'sum': result = values.reduce((a, b) => a + b, 0); break;
    case 'difference': result = values[0] - values[1]; break;
    case 'product': result = values.reduce((a, b) => a * b, 1); break;
    case 'ratio': result = values[1] === 0 ? 'undefined (division by zero)' : values[0] / values[1]; break;
    default: result = 'Unsupported operation';
  }
  output.textContent = typeof result === 'number' ? String(Number(result.toPrecision(12))) : result;
});
