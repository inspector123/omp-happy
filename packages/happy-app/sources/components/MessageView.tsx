import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { useIsMessageQueued, useIsQueuedMessageEditable, useSetting } from '@/sync/storage';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
  /**
   * Long-press handler for a user-text bubble that is still queued in the
   * send outbox. Pulls the message back for editing.
   */
  onEditQueuedMessage?: (message: UserTextMessage) => void;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          onForkFromUserMessage={props.onForkFromUserMessage}
          onEditQueuedMessage={props.onEditQueuedMessage}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
  onEditQueuedMessage?: (message: UserTextMessage) => void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          onForkFromUserMessage={props.onForkFromUserMessage}
          onEditQueuedMessage={props.onEditQueuedMessage}
        />
      );

    case 'agent-text':
      return props.message.isThinking
        ? <AgentReasoningBlock message={props.message} sessionId={props.sessionId} />
        : <AgentTextBlock message={props.message} sessionId={props.sessionId} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
  onEditQueuedMessage?: (message: UserTextMessage) => void;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Queued display state is independent from the narrower safe-edit state.
  // Attachment sends and anything that entered a POST remain visibly queued,
  // but never get an edit or fork long-press action.
  const isQueued = useIsMessageQueued(props.sessionId, props.message.localId);
  const isQueuedEditable = useIsQueuedMessageEditable(props.sessionId, props.message.localId);
  const handleEditPress = React.useCallback(() => {
    props.onEditQueuedMessage?.(props.message);
  }, [props.onEditQueuedMessage, props.message]);

  const rewindPointId = props.message.claudeUuid ?? props.message.codexItemId;
  const canFork = Boolean(props.onForkFromUserMessage)
    && (Boolean(rewindPointId) || props.metadata?.flavor === 'codex');
  const handleLongPress = React.useCallback(() => {
    if (props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, rewindPointId, props.message.text);
    }
  }, [props.message.id, props.message.text, props.onForkFromUserMessage, rewindPointId]);

  const longPressHandler = isQueued
    ? (isQueuedEditable && props.onEditQueuedMessage ? handleEditPress : undefined)
    : (canFork ? handleLongPress : undefined);

  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  const isClaudeFlavor = !props.metadata?.flavor || props.metadata.flavor === 'claude';
  if (isClaudeFlavor && !isQueued && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'goal-confirmation') {
    return null;
  }
  if (parsed.kind === 'goal-run') {
    return (
      <View style={styles.userMessageContainer}>
        <Pressable
          onLongPress={longPressHandler}
          delayLongPress={400}
          style={[styles.userMessageBubble, styles.goalMessageBubble]}
        >
          <MarkdownView markdown={parsed.goal} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
        </Pressable>
        {isQueued ? (
          <QueuedMessageStatus />
        ) : (
          <View style={styles.goalSentRow}>
            <Ionicons name="locate-outline" size={16} color={styles.goalSentText.color} />
            <Text style={styles.goalSentText}>{t('message.sentAsGoal')}</Text>
          </View>
        )}
      </View>
    );
  }
  if (parsed.kind === 'command-run') {
    return (
      <View style={styles.userMessageContainer}>
        {parsed.args ? (
          <Pressable
            onLongPress={longPressHandler}
            delayLongPress={400}
            style={[styles.userMessageBubble, styles.commandMessageBubble]}
          >
            <MarkdownView markdown={parsed.args} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
          </Pressable>
        ) : null}
        <Pressable
          onLongPress={longPressHandler}
          delayLongPress={400}
          style={[styles.commandChip, isQueued && styles.commandMessageBubble]}
        >
          <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
        </Pressable>
        {isQueued && <QueuedMessageStatus />}
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      <Pressable
        onLongPress={longPressHandler}
        delayLongPress={400}
        style={[styles.userMessageBubble, isQueued && styles.goalMessageBubble]}
      >
        <MarkdownView markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
      {isQueued && <QueuedMessageStatus />}
    </View>
  );
}

function QueuedMessageStatus() {
  return (
    <View style={styles.goalSentRow}>
      <Ionicons name="time-outline" size={16} color={styles.goalSentText.color} />
      <Text style={styles.goalSentText}>{t('message.queued')}</Text>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
    </View>
  );
}

// Reasoning / thinking block. Hidden in upstream Happy; we render it (muted)
// behind the `showReasoning` setting so omp's reasoning is visible.
function AgentReasoningBlock(props: { message: AgentTextMessage; sessionId: string }) {
  const showReasoning = useSetting('showReasoning');
  if (!showReasoning) {
    return null;
  }
  return (
    <View style={styles.reasoningContainer}>
      <View style={styles.reasoningHeader}>
        <Ionicons name="bulb-outline" size={13} color={styles.reasoningLabel.color as string} />
        <Text style={styles.reasoningLabel}>Reasoning</Text>
      </View>
      <MarkdownView markdown={props.message.text} sessionId={props.sessionId} />
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'subagent-lifecycle') {
    return null;
  }
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  if (props.event.type === 'advisor') {
    return (
      <View style={styles.advisorContainer}>
        <View style={styles.advisorHeader}>
          <Ionicons name="document-text-outline" size={14} color={styles.advisorLabel.color as string} />
          <Text style={styles.advisorLabel}>Advisor</Text>
        </View>
        {props.event.notes.map((note, index) => (
          <View key={index} style={styles.advisorNoteCard}>
            <View style={styles.advisorNoteMeta}>
              {note.severity ? (
                <View style={[
                  styles.severityBadge,
                  note.severity === 'blocker' && styles.severityBlocker,
                  note.severity === 'concern' && styles.severityConcern,
                ]}>
                  <Text style={styles.severityText}>{note.severity}</Text>
                </View>
              ) : null}
              {note.advisor ? (
                <Text style={styles.advisorSource}>{note.advisor}</Text>
              ) : null}
            </View>
            <MarkdownView markdown={note.note} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  goalMessageBubble: {
    marginBottom: 6,
  },
  commandMessageBubble: {
    marginBottom: 6,
  },
  goalSentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.72,
  },
  goalSentText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    maxWidth: '100%',
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
  reasoningContainer: {
    marginBottom: 12,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.divider,
    opacity: 0.78,
  },
  reasoningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  reasoningLabel: {
    color: theme.colors.agentEventText,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Advisor card styles
  advisorContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    maxWidth: '100%',
  },
  advisorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  advisorLabel: {
    color: theme.colors.agentEventText,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  advisorNoteCard: {
    backgroundColor: theme.colors.groupped.background,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  advisorNoteMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  severityBadge: {
    backgroundColor: theme.colors.divider,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  severityConcern: {
    backgroundColor: '#f59e0b',
  },
  severityBlocker: {
    backgroundColor: '#ef4444',
  },
  severityText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  advisorSource: {
    color: theme.colors.agentEventText,
    fontSize: 11,
    fontStyle: 'italic',
  },
}));
