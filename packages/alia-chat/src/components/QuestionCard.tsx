import { Questionnaire, type QuestionnaireAnswers } from '@oxy.so/bloom/questionnaire';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { type AskedQuestion, formatAnswers } from '../lib/questions';

interface QuestionCardProps {
  questions: AskedQuestion[];
  /** Sends the answers as the person's next message. Absent: the card is read-only. */
  onSubmit?: (message: string) => void;
}

/** Ids are positions: the questions are the model's, and carry none. */
const idOf = (index: number) => `q${index}`;

/**
 * The questions Alia asked: Bloom's `Questionnaire` while the person can still answer, and
 * the questions as plain lines once they have (the answer is their message, right below).
 * Typing a reply in the composer answers just as well, which is why there is no dismiss.
 */
export function QuestionCard({ questions, onSubmit }: QuestionCardProps) {
  if (onSubmit === undefined) {
    return (
      <View className="my-2 gap-1">
        {questions.map((q, i) => (
          // The model's questions never reorder: the position is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Muted key={i}>{q.question}</Muted>
        ))}
      </View>
    );
  }

  const complete = (answers: QuestionnaireAnswers) =>
    onSubmit(
      formatAnswers(
        questions,
        questions.map((_, i) => ({
          picked: (answers[idOf(i)]?.values ?? []).map(Number),
          other: answers[idOf(i)]?.other,
        })),
      ),
    );

  return (
    <View className="my-2">
      <Questionnaire
        questions={questions.map((q, i) => ({
          id: idOf(i),
          question: q.question,
          select: q.multiSelect ? 'multiple' : 'single',
          other: true,
          options: q.options.map((option, index) => ({
            value: String(index),
            label: option.label,
            description: option.description,
          })),
        }))}
        onComplete={complete}
      />
    </View>
  );
}
