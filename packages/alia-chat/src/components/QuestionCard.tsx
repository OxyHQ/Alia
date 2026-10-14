import { Questionnaire, type QuestionnaireAnswers } from '@oxy.so/bloom/questionnaire';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { type AskedQuestion, formatAnswers } from '../lib/questions';

interface QuestionCardProps {
  questions: AskedQuestion[];
  /** Sends the answers as the person's next message. */
  onSubmit: (message: string) => void;
  /** Shows the corner dismiss; typing a reply in the composer answers just as well. */
  onDismiss?: () => void;
}

/** Ids are positions: the questions are the model's, and carry none. */
const idOf = (index: number) => `q${index}`;

/**
 * The questions Alia asked, as Bloom's `Questionnaire`. Give it to the composer's `question`
 * slot while the person can still answer: it docks above the composer, where they are about
 * to type, rather than sitting in the thread.
 */
export function QuestionCard({ questions, onSubmit, onDismiss }: QuestionCardProps) {
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
      onDismiss={onDismiss}
    />
  );
}

/** The questions Alia asked, as plain lines: the thread's record of them once they are answered. */
export function AskedQuestions({ questions }: { questions: AskedQuestion[] }) {
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
