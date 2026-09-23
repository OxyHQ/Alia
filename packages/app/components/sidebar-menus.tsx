import type { Conversation } from '@/lib/hooks/use-conversations';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { Project } from '@/lib/stores/projects-store';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import React from 'react';

/** The radio value for "in no project"; project ids are `project-<n>`. */
const NO_PROJECT = '';

/** The ⋯ button every sidebar menu opens from. */
function MoreTrigger({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild label={label}>
      <Button
        iconOnly
        appearance="plain"
        tone="neutral"
        size="xs"
        leadingIcon={RiMoreFill}
        accessibilityLabel={label}
      />
    </DropdownMenuTrigger>
  );
}

/** A chat row's menu: rename, move to a project, delete. */
export const ConversationActions = React.memo(function ConversationActions({
  conversation,
  projects,
  projectId,
  onRename,
  onMove,
  onDelete,
}: {
  conversation: Conversation;
  projects: readonly Project[];
  /** The project the chat is in, if any. */
  projectId: string | undefined;
  onRename: (conversation: Conversation) => void;
  onMove: (conversationId: string, projectId: string | null) => void;
  onDelete: (conversation: Conversation) => void;
}) {
  const { t } = useTranslation();
  const title = conversation.title || t('sidebar.newConversation');
  return (
    <DropdownMenu>
      <MoreTrigger label={t('sidebar.chatOptions', { title })} />
      <DropdownMenuContent minWidth={200}>
        <DropdownMenuItem onPress={() => onRename(conversation)}>
          {t('sidebar.rename')}
        </DropdownMenuItem>
        {projects.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('sidebar.moveToProject')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent side="right" align="start">
              <DropdownMenuRadioGroup
                value={projectId ?? NO_PROJECT}
                onValueChange={(value) => onMove(conversation.id, value || null)}
              >
                <DropdownMenuRadioItem value={NO_PROJECT}>
                  {t('sidebar.noProject')}
                </DropdownMenuRadioItem>
                {projects.map((project) => (
                  <DropdownMenuRadioItem key={project.id} value={project.id}>
                    {project.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onPress={() => onDelete(conversation)}>
          {t('sidebar.deleteChat')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** A project folder's menu: edit, delete. */
export const ProjectActions = React.memo(function ProjectActions({
  project,
  onEdit,
  onDelete,
}: {
  project: Project;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <MoreTrigger label={t('sidebar.projectOptions', { name: project.name })} />
      <DropdownMenuContent minWidth={180}>
        <DropdownMenuItem onPress={() => onEdit(project)}>{t('sidebar.editProject')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onPress={() => onDelete(project)}>
          {t('sidebar.deleteProject')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** The tree's own action: a new project. */
export function NewProjectAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      iconOnly
      appearance="plain"
      tone="neutral"
      size="xs"
      leadingIcon={RiAddLine}
      accessibilityLabel={t('sidebar.newProject')}
      onPress={onPress}
    />
  );
}

/** Rename a chat. Open while `conversation` is set. */
export function RenameConversationDialog({
  conversation,
  onClose,
  onRename,
}: {
  conversation: Conversation | null;
  onClose: () => void;
  onRename: (conversation: Conversation, title: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = React.useState('');

  React.useEffect(() => {
    if (conversation) setTitle(conversation.title ?? '');
  }, [conversation]);

  const trimmed = title.trim();
  const unchanged = trimmed === (conversation?.title ?? '').trim();
  const submit = () => {
    if (!conversation || !trimmed || unchanged) return;
    onRename(conversation, trimmed);
    onClose();
  };

  return (
    <Dialog
      open={conversation !== null}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('sidebar.renameTitle')}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        { label: t('common.save'), onPress: submit, disabled: !trimmed || unchanged },
      ]}
    >
      <TextFieldInput
        label={t('sidebar.renameLabel')}
        value={title}
        onValueChange={setTitle}
        onSubmitEditing={submit}
        selectTextOnFocus
        autoFocus
      />
    </Dialog>
  );
}
