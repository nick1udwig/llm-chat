import React, { useEffect, useState, useRef, useCallback, useImperativeHandle } from 'react';
import { Anthropic } from '@anthropic-ai/sdk';
import { Tool, CacheControlEphemeral, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy';
import { Textarea } from '@/components/ui/textarea';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message, MessageContent } from './types';
import { Spinner } from '@/components/ui/spinner';
import { ToolCallModal } from './ToolCallModal';
import { useProjects } from './context/ProjectContext';
import { useFocusControl } from './context/useFocusControl';
import { useMcp } from './context/McpContext';

const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

export interface ChatViewRef {
  focus: () => void;
}

const ChatViewComponent = React.forwardRef<ChatViewRef>((props, ref) => {
  const {
    projects,
    activeProjectId,
    activeConversationId,
    updateProjectSettings,
    renameConversation,
  } = useProjects();

  const activeProject = projects.find(p => p.id === activeProjectId);
  const activeConversation = activeProject?.conversations.find(
    c => c.id === activeConversationId
  );

  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shouldCancelRef = useRef<boolean>(false);
  const { servers, executeTool } = useMcp();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selectedToolCall, setSelectedToolCall] = useState<{
    name: string;
    input: Record<string, unknown>;
    result: string | null;
  } | null>(null);

  // Use the focus control hook for managing conversation focus
  useFocusControl();

  // Expose the focus method to parent components
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      },
    }),
    []
  );

  // Focus input when opening a new chat or when a chat is selected
  useEffect(() => {
    if (inputRef.current && activeConversation) {
      inputRef.current.focus();
    }
  }, [activeConversation]);

  // Scroll handling logic
  useEffect(() => {
    if (!chatContainerRef.current) return;
    const container = chatContainerRef.current;
    container.scrollTop = container.scrollHeight;
  }, []); 

  // Handle message updates
  useEffect(() => {
    if (!chatContainerRef.current || !activeConversation?.messages.length) {
      return;
    }

    const lastMessage = activeConversation.messages[activeConversation.messages.length - 1];

    if (lastMessage.role === 'assistant' || lastMessage.role === 'user') {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [activeConversation?.messages, activeConversation?.lastUpdated]);

  const getUniqueTools = (should_cache: boolean) => {
    if (!activeProject?.settings.mcpServers?.length) {
      return [];
    }

    const toolMap = new Map<string, Tool>();

    servers
      .filter(server =>
        activeProject.settings.mcpServers.some(
          configuredServer => configuredServer.id === server.id
        )
      )
      .flatMap(s => s.tools || [])
      .forEach(tool => {
        if (!toolMap.has(tool.name)) {
          toolMap.set(tool.name, {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema
          });
        }
      });

    const tools = Array.from(toolMap.values());
    return !should_cache ? tools : tools.map((t, index, array) => index != array.length - 1 ? t : { ...t, cache_control: {type: 'ephemeral'} as CacheControlEphemeral});
  };

  const updateConversationMessages = (projectId: string, conversationId: string, newMessages: Message[]) => {
    updateProjectSettings(projectId, {
      conversations: activeProject!.conversations.map(conv =>
        conv.id === conversationId
          ? {
              ...conv,
              messages: newMessages,
              lastUpdated: new Date()
            }
          : conv
      )
    });
  };

  const cancelCurrentCall = useCallback(() => {
    shouldCancelRef.current = true;
    setIsLoading(false);
    setError('Operation cancelled');
  }, []);

  const handleSendMessage = async () => {
    shouldCancelRef.current = false;
    if (!inputMessage.trim() || !activeProject || !activeConversationId) return;
    if (!activeProject.settings.apiKey) {
      setError('Please set your API key in settings');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const userMessage: Message = {
        role: 'user',
        content: [{
          type: 'text' as const,
          text: inputMessage,
        }],
        timestamp: new Date()
      };

      const currentMessages = [...(activeConversation?.messages || []), userMessage];
      updateConversationMessages(activeProject.id, activeConversationId, currentMessages);
      setInputMessage('');

      const anthropic = new Anthropic({
        apiKey: activeProject.settings.apiKey,
        dangerouslyAllowBrowser: true
      });

      const savedToolResults = new Set<string>();

      const toolsCached = getUniqueTools(true);
      const tools = getUniqueTools(false);

      const systemPromptContent = [
        {
          type: "text",
          text: `${activeProject.settings.systemPrompt || ''}`,
        },
      ] as TextBlockParam[];

      while (true) {
        const cachedApiMessages = currentMessages.map((m, index, array) =>
          index < array.length - 3 ?
            {
              role: m.role,
              content: m.content,
              toolInput: m.toolInput ? m.toolInput : undefined,
            } :
            {
              role: m.role,
              content: (typeof m.content === 'string' ?
                [{ type: 'text' as const, text: m.content, cache_control: {type: 'ephemeral'} as CacheControlEphemeral }]
                : m.content.map((c, index, array) =>
                  index != array.length - 1 ? c :
                  {
                    ...c,
                    cache_control: {type: 'ephemeral'} as CacheControlEphemeral,
                  }
                )) as MessageContent[],
              toolInput: m.toolInput ? m.toolInput : undefined,
            }
        );

        const newestToolResultId = currentMessages
          .filter((msg): msg is Message & { content: MessageContent[] } =>
            Array.isArray(msg.content)
          )
          .flatMap(msg => msg.content)
          .filter((content): content is MessageContent & { tool_use_id: string } =>
            'tool_use_id' in content && content.type === 'tool_result'
          )
          .map(content => content.tool_use_id)
          .pop();

        if (activeProject.settings.elideToolResults) {
          if ((cachedApiMessages[cachedApiMessages.length - 1].content as MessageContent[])[0].type === 'tool_result') {
            const keepToolResponse = await anthropic.messages.create({
              model: DEFAULT_MODEL,
              max_tokens: 8192,
              messages: [
                ...cachedApiMessages.filter(msg => {
                  if (!Array.isArray(msg.content)) return false;
                  const toolResult = msg.content.find(c =>
                    c.type === 'tool_use' || c.type === 'tool_result'
                  );
                  return toolResult;
                }).map(msg =>
                  !(msg.content as MessageContent[]).find(c => c.type === 'tool_result') ?
                  {
                    ...msg,
                    content: [
                      msg.content[0],
                      {
                        type: 'text' as const,
                        text: `${JSON.stringify(msg.content[1])}`,
                      },
                    ],
                  } :
                  {
                    ...msg,
                    content: [
                      {
                        type: 'text' as const,
                        text: `${JSON.stringify({ ...(msg.content as MessageContent[])[0], content: 'elided'})}`,
                      },
                    ],
                  }
                ),
                {
                  role: 'user' as const,
                  content: [{
                    type: 'text' as const,
                    text: 'Rate each `message`: will the `type: tool_result` be required by `assistant` to serve the next response? Reply ONLY with `<tool_use_id>: Yes` or `<tool_use_id>: No` for each tool_result. DO NOT reply with code, prose, or commentary of any kind.\nExample output:\ntoolu_014huykAonadokihkrboFfqn: Yes\ntoolu_01APhxfkQZ1nT7Ayt8Vtyuz8: Yes\ntoolu_01PcgSwHbHinNrn3kdFaD82w: No\ntoolu_018Qosa8PHAZjUa312TXRwou: Yes',
                    cache_control: {type: 'ephemeral'} as CacheControlEphemeral,
                  }],
                },
              ] as Message[],
              system: [{
                type: 'text' as const,
                text: 'Rate each `message`: will the `type: tool_result` be required by `assistant` to serve the next response? Reply ONLY with `<tool_use_id>: Yes` or `<tool_use_id>: No` for each tool_result. DO NOT reply with code, prose, or commentary of any kind.\nExample output:\ntoolu_014huykAonadokihkrboFfqn: Yes\ntoolu_01APhxfkQZ1nT7Ayt8Vtyuz8: Yes\ntoolu_01PcgSwHbHinNrn3kdFaD82w: No\ntoolu_018Qosa8PHAZjUa312TXRwou: Yes',
                cache_control: {type: 'ephemeral'} as CacheControlEphemeral,
              }],
            });

            if (keepToolResponse.content[0].type === 'text') {
              console.log('a');
              const lines = keepToolResponse.content[0].text.split('\n');

              for (const line of lines) {
                const [key, value] = line.split(': ');

                if (value.trim() === 'Yes') {
                  console.log('b');
                  savedToolResults.add(key);
                } else if (value.trim() === 'No') {
                  console.log('c');
                  savedToolResults.delete(key);
                }
              }
            }
            console.log(`keepToolResponse: ${JSON.stringify(keepToolResponse)}\n${JSON.stringify(savedToolResults)}`);
          }
        }

        const apiMessagesToSend = !activeProject.settings.elideToolResults ? cachedApiMessages :
          cachedApiMessages
            .map(msg => {
              if (!Array.isArray(msg.content)) return msg;

              const toolResult = msg.content.find(c =>
                c.type === 'tool_result'
              );
              if (!toolResult) return msg;

              const toolUseId = (toolResult as { tool_use_id: string }).tool_use_id;
              return toolUseId === newestToolResultId || savedToolResults.has(toolUseId) ?
                msg :
                {
                  ...msg,
                  content: [{
                    ...msg.content[0],
                    content: 'elided',
                  }],
                };
            });

        const currentStreamMessage = {
          role: 'assistant' as const,
          content: [] as MessageContent[],
          timestamp: new Date(),
        };

        const textContent: MessageContent = {
          type: 'text',
          text: '',
        };
        currentStreamMessage.content.push(textContent);

        const stream = await anthropic.messages.stream({
          model: activeProject.settings.model || DEFAULT_MODEL,
          max_tokens: 8192,
          messages: apiMessagesToSend,
          ...(systemPromptContent && {
            system: systemPromptContent
          }),
          ...(tools.length > 0 && {
            tools: toolsCached
          })
        }).on('text', (text) => {
          textContent.text += text;
          // Update conversation with streaming message
          const updatedMessages = [...currentMessages, currentStreamMessage];
          updateConversationMessages(activeProject.id, activeConversationId, updatedMessages);
        });

        // Handle tool use in the final response if any
        const finalResponse = await stream.finalMessage();
        
        // If this is a new conversation, generate a title
        if (activeConversation && cachedApiMessages.length === 2) {
          const userFirstMessage = cachedApiMessages[0].content;
          const assistantFirstMessage = cachedApiMessages[1].content;

          const summaryResponse = await anthropic.messages.create({
            model: activeProject.settings.model || DEFAULT_MODEL,
            max_tokens: 20,
            messages: [{
              role: "user",
              content: `User: ${JSON.stringify(userFirstMessage)}\nAssistant: ${Array.isArray(assistantFirstMessage)
                ? assistantFirstMessage.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join(' ')
                : assistantFirstMessage}\n\n# Based on the above chat exchange, generate a very brief (2-5 words) title that captures the main topic or purpose.`
            }]
          });

          const type = summaryResponse.content[0].type;
          if (type == 'text') {
            const suggestedTitle = summaryResponse.content[0].text
              .replace(/["']/g, '')
              .replace('title:', '')
              .replace('Title:', '')
              .replace('title', '')
              .replace('Title', '')
              .trim();
            if (suggestedTitle) {
              renameConversation(activeProject.id, activeConversationId, suggestedTitle);
            }
          }
        }

        // Check for and handle tool use
        const toolUseContent = finalResponse.content.find((c: MessageContent) => c.type === 'tool_use');
        if (toolUseContent && toolUseContent.type === 'tool_use') {
          try {
            const serverWithTool = servers.find(s =>
              s.tools?.some(t => t.name === toolUseContent.name)
            );

            if (!serverWithTool) {
              throw new Error(`No server found for tool ${toolUseContent.name}`);
            }

            const result = await executeTool(
              serverWithTool.id,
              toolUseContent.name,
              toolUseContent.input as Record<string, unknown>,
            );

            const toolResultMessage: Message = {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseContent.id,
                content: result,
              }],
              timestamp: new Date()
            };

            currentMessages.push(toolResultMessage);
            updateConversationMessages(activeProject.id, activeConversationId, currentMessages);

            // Continue the conversation with the tool result
            continue;
          } catch (error) {
            const errorMessage: Message = {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseContent.id,
                content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                is_error: true,
              }],
              timestamp: new Date()
            };

            currentMessages.push(errorMessage);
            updateConversationMessages(activeProject.id, activeConversationId, currentMessages);
          }
        }

        // Break the loop if no tool use or should cancel
        if (shouldCancelRef.current || !toolUseContent) {
          break;
        }
      }

    } catch (error) {
      console.error('Failed to send message:', error);
      if (!shouldCancelRef.current) {
        setError(error instanceof Error ? error.message : 'An error occurred');
      }
    } finally {
      shouldCancelRef.current = false;
      setIsLoading(false);

      // Focus the input field after the LLM finishes talking
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  };

  const renderMessage = (message: Message, index: number) => {
    if (Array.isArray(message.content)) {
      return message.content.map((content, contentIndex) => {
        if (content.type === 'text') {
          return (
            <div
              key={`text-${index}-${contentIndex}`}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className="relative group">
              <div className="absolute right-2 top-2 z-10">
                  <CopyButton
                    text={content.text}
                    title="Copy message"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2 ${
                    message.role === 'user'
                      ? 'bg-muted text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  <ReactMarkdown
                    className="prose dark:prose-invert max-w-none"
                    components={{
                      pre({ node, children, ...props }) {
                        return (
                          <div className="group/code relative">
                            <div className="sticky top-2 float-right -mr-2 z-10">
                              <CopyButton
                                text={node?.children[0]?.children[0]?.value || ''}
                                title="Copy code"
                                className="opacity-0 group-hover/code:opacity-100 transition-opacity"
                              />
                            </div>
                            <pre {...props}>{children}</pre>
                          </div>
                        );
                      },
                      a: ({href, children}) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          {children}
                        </a>
                      ),
                    }}
                    remarkPlugins={[remarkGfm]}
                  >
                    {content.text}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          );
        } else if (content.type === 'tool_use') {
          const nextMessage = activeConversation?.messages[index + 1];
          let toolResult = null;
          if (nextMessage && Array.isArray(nextMessage.content)) {
            const resultContent = nextMessage.content.find(c =>
              c.type === 'tool_result' && c.tool_use_id === content.id
            );
            if (resultContent && resultContent.type === 'tool_result') {
              toolResult = resultContent.content;
            }
          }

          return (
            <div
              key={`tool_use-${index}-${contentIndex}`}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                key={`message-${index}-content-${contentIndex}`}
                className={`max-w-[80%] rounded-lg px-4 py-2 relative group ${
                  message.role === 'user'
                    ? 'bg-muted text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                <button
                  onClick={() => setSelectedToolCall({
                    name: content.name,
                    input: content.input,
                    result: toolResult
                  })}
                  className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 underline"
                >
                  Use tool: {content.name}
                </button>
              </div>
            </div>
          );
        }
        return null;
      });
    }

    return (
      <div
        key={`string-${index}`}
        className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
      >
        <div
          className={`max-w-[80%] rounded-lg px-4 py-2 ${
            message.role === 'user'
              ? 'bg-muted text-primary-foreground'
              : 'bg-muted text-foreground'
          }`}
        >
          <ReactMarkdown
            className="prose dark:prose-invert max-w-none"
            components={{
              a: ({href, children}) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {children}
                </a>
              )
            }}
            remarkPlugins={[remarkGfm]}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    );
  };

  if (!activeConversation) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative">
      <div ref={chatContainerRef} className="h-[calc(100vh-8rem)] overflow-y-auto p-4">
        <div className="space-y-4 mb-4">
          {activeConversation.messages.map((message, index) => (
            renderMessage(message, index)
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="flex gap-2 p-2 bg-background fixed bottom-0 left-0 right-0 z-50 md:left-[280px] md:w-[calc(100%-280px)]">
          <Textarea
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Type your message"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
            ref={inputRef}
            className="flex-1"
          maxRows={8}
          disabled={isLoading}
        />
        <Button
          onClick={isLoading ? cancelCurrentCall : handleSendMessage}
          disabled={!activeProjectId || !activeConversationId}
          className="self-end relative"
        >
          {isLoading ? (
            <Square className="w-4 h-4" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </Button>
      </div>

      {selectedToolCall && (
        <ToolCallModal
          toolCall={selectedToolCall}
          onClose={() => setSelectedToolCall(null)}
        />
      )}
    </div>
  );
});

// Display name for debugging purposes
ChatViewComponent.displayName = 'ChatView';

// Export a memo'd version for better performance
export const ChatView = React.memo(ChatViewComponent);