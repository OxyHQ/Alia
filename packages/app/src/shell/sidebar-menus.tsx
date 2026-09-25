import type { Conversation } from '@/features/chat/runtime/use-conversations';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Folder } from '@/features/projects/runtime/folders-store';
import type { Project } from '@/features/projects/runtime/projects-store';
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
import { Loading } from '@oxy.so/bloom/loading';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useKeyboardOnOpen } from '@/shared/platform/use-keyboard-on-open';
import React from 'react';
import { View } from 'react-native';

/** The radio value for "in none"; project and folder ids are `project-<n>` / `folder-<n>`. */
const NONE = '';

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

/**
 * A chat row's menu: rename, pin, favourite, move to a project or a folder,
 * delete. A chat is filed in one place at most, so moving it into a project
 * takes it out of its folder and the other way round (the sidebar does that).
 */
export const ConversationActions = React.memo(function ConversationActions({
  conversation,
  projects,
  projectId,
  folders,
  folderId,
  pinned,
  favorite,
  onRename,
  onTogglePin,
  onToggleFavorite,
  onMove,
  onMoveToFolder,
  onDelete,
}: {
  conversation: Conversation;
  projects: readonly Project[];
  /** The project the chat is in, if any. */
  projectId: string | undefined;
  folders: readonly Folder[];
  /** The folder the chat is in, if any. */
  folderId: string | undefined;
  pinned: boolean;
  favorite: boolean;
  onRename: (conversation: Conversation) => void;
  onTogglePin: (conversationId: string) => void;
  onToggleFavorite: (conversationId: string) => void;
  onMove: (conversationId: string, projectId: string | null) => void;
  onMoveToFolder: (conversationId: string, folderId: string | null) => void;
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
        <DropdownMenuItem onPress={() => onTogglePin(conversation.id)}>
          {t(pinned ? 'sidebar.unpin' : 'sidebar.pin')}
        </DropdownMenuItem>
        <DropdownMenuItem onPress={() => onToggleFavorite(conversation.id)}>
          {t(favorite ? 'sidebar.removeFavorite' : 'sidebar.addFavorite')}
        </DropdownMenuItem>
        {projects.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('sidebar.moveToProject')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent side="right" align="start">
              <DropdownMenuRadioGroup
                value={projectId ?? NONE}
                onValueChange={(value) => onMove(conversation.id, value || null)}
              >
                <DropdownMenuRadioItem value={NONE}>
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
        {folders.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('sidebar.moveToFolder')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent side="right" align="start">
              <DropdownMenuRadioGroup
                value={folderId ?? NONE}
                onValueChange={(value) => onMoveToFolder(conversation.id, value || null)}
              >
                <DropdownMenuRadioItem value={NONE}>
                  {t('sidebar.noFolder')}
                </DropdownMenuRadioItem>
                {folders.map((folder) => (
                  <DropdownMenuRadioItem key={folder.id} value={folder.id}>
                    {folder.name}
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

/** The spinner beside the chat that is being answered right now. */
export function StreamingIndicator() {
  const { t } = useTranslation();
  return (
    <View accessible accessibilityLabel={t('sidebar.responding')} style={{ paddingHorizontal: 4 }}>
      <Loading variant="spinner" iconSize={14} />
    </View>
  );
}

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

/** A folder's menu: rename, delete. */
export const FolderActions = React.memo(function FolderActions({
  folder,
  onRename,
  onDelete,
}: {
  folder: Folder;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <MoreTrigger label={t('sidebar.folderOptions', { name: folder.name })} />
      <DropdownMenuContent minWidth={180}>
        <DropdownMenuItem onPress={() => onRename(folder)}>{t('sidebar.renameFolder')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onPress={() => onDelete(folder)}>
          {t('sidebar.deleteFolder')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** The tree's own action: a new project or a new folder. */
export function NewCollectionAction({
  onNewProject,
  onNewFolder,
}: {
  onNewProject: () => void;
  onNewFolder: () => void;
}) {
  const { t } = useTranslation();
  const label = t('sidebar.newCollection');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={label}>
        <Button
          iconOnly
          appearance="plain"
          tone="neutral"
          size="xs"
          leadingIcon={RiAddLine}
          accessibilityLabel={label}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent minWidth={180}>
        <DropdownMenuItem onPress={onNewProject}>{t('sidebar.newProject')}</DropdownMenuItem>
        <DropdownMenuItem onPress={onNewFolder}>{t('sidebar.newFolder')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A folder section's own action: a new agent. */
export function NewAgentAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      iconOnly
      appearance="plain"
      tone="neutral"
      size="xs"
      leadingIcon={RiAddLine}
      accessibilityLabel={t('agents.createAgent')}
      onPress={onPress}
    />
  );
}

/**
 * Name a new folder, or rename one. Open while `state` is set; `folder` is the
 * folder being renamed, absent for a new one.
 */
export function FolderNameDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: { folder?: Folder } | null;
  onClose: () => void;
  onSubmit: (name: string, folder: Folder | undefined) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (state) setName(state.folder?.name ?? '');
  }, [state]);

  const folderInput = useKeyboardOnOpen(state !== null);

  const trimmed = name.trim();
  const unchanged = state?.folder !== undefined && trimmed === state.folder.name.trim();
  const submit = () => {
    if (!state || !trimmed || unchanged) return;
    onSubmit(trimmed, state.folder);
    onClose();
  };

  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t(state?.folder ? 'sidebar.renameFolderTitle' : 'sidebar.newFolderTitle')}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t(state?.folder ? 'common.save' : 'common.create'),
          onPress: submit,
          disabled: !trimmed || unchanged,
        },
      ]}
    >
      <TextFieldInput
        label={t('sidebar.folderName')}
        value={name}
        onValueChange={setName}
        onSubmitEditing={submit}
        selectTextOnFocus
        autoFocus
        inputRef={folderInput}
      />
    </Dialog>
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

  const titleInput = useKeyboardOnOpen(conversation !== null);

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
        inputRef={titleInput}
      />
    </Dialog>
  );
}
