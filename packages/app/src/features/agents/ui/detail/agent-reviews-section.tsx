import { AgentDetailSection } from '@/features/agents/ui/detail/agent-detail-section';
import { errorMessage as getErrorMessage } from '@/shared/api/error-utils';
import {
  useAgentReviewDraft,
  useAgentReviews,
  useDeleteAgentReview,
  useSubmitAgentReview,
} from '@/features/agents/runtime/use-agent-reviews';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { Rating, RatingInput } from '@oxy.so/bloom/rating';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';

/**
 * What people said about the agent, and the caller's own review — written,
 * rewritten or deleted here. The owner cannot review their own agent.
 */
export function AgentReviewsSection({
  agentId,
  viewerId,
  isOwner,
}: {
  agentId: string;
  /** The signed-in person, or null for a reader without an account. */
  viewerId: string | null;
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  const { data } = useAgentReviews(agentId);
  const reviews = data?.reviews ?? [];
  const userReview = data?.userReview ?? null;
  const draft = useAgentReviewDraft(data?.userReview);
  const submitReview = useSubmitAgentReview(agentId);
  const deleteReview = useDeleteAgentReview(agentId);
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async () => {
    if (!draft.rating || submitReview.isPending) return;
    try {
      await submitReview.mutateAsync({
        rating: draft.rating,
        comment: draft.comment.trim(),
      });
      setShowForm(false);
      toast.success(t('agents.reviewSubmitted'));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Failed to submit review'));
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t('agents.deleteReview'),
      description: t('agents.deleteReviewConfirm'),
      confirmLabel: t('agents.deleteReview'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteReview.mutateAsync();
      draft.reset();
      toast.success(t('agents.reviewDeleted'));
    } catch {
      toast.error(t('agents.reviewDeleteFailed'));
    }
  };

  return (
    <AgentDetailSection
      title={t('agents.reviews')}
      action={
        viewerId !== null && !isOwner && !showForm ? (
          <Button size="sm" appearance="plain" onPress={() => setShowForm(true)}>
            {userReview ? t('agents.editReview') : t('agents.writeReview')}
          </Button>
        ) : null
      }
    >
      {showForm && (
        <Card appearance="outline">
          <CardBody>
            <View className="gap-3 py-1">
              <RatingInput
                value={draft.rating || null}
                onChange={draft.setRating}
                accessibilityLabel={t('agents.reviews')}
              />
              <Textarea
                value={draft.comment}
                onValueChange={draft.setComment}
                placeholder={t('agents.reviewPlaceholder')}
                rows={3}
                autoResize
              />
              <View className="flex-row justify-end gap-2">
                <Button
                  size="sm"
                  tone="neutral"
                  appearance="plain"
                  onPress={() => setShowForm(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  tone="action"
                  onPress={handleSubmit}
                  disabled={!draft.rating}
                  loading={submitReview.isPending}
                >
                  {t('agents.writeReview')}
                </Button>
              </View>
            </View>
          </CardBody>
        </Card>
      )}

      {reviews.length === 0 && !showForm ? (
        <Muted>{t('agents.noReviews')}</Muted>
      ) : (
        <View className="gap-3">
          {reviews.map((review) => (
            <View key={review._id} className="gap-1">
              <View className="flex-row items-center gap-2">
                <Text variant="body-medium">
                  {review.userId?.username || 'User'}
                </Text>
                <Rating value={review.rating} size="small" />
                <View className="flex-1" />
                {viewerId !== null && review.userId?._id === viewerId && (
                  <Button
                    size="xs"
                    tone="neutral"
                    appearance="plain"
                    icon={RiDeleteBinLine}
                    accessibilityLabel={t('agents.deleteReview')}
                    onPress={handleDelete}
                  />
                )}
              </View>
              {review.comment ? (
                <Text variant="body-regular">{review.comment}</Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </AgentDetailSection>
  );
}
