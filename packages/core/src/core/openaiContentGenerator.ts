/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Content,
  Part,
  FunctionCall,
  FunctionResponse,
  ContentListUnion,
  FinishReason,
  Candidate,
} from '@google/genai';
import { ContentGenerator } from './contentGenerator.js';
import { UserTierId } from '../code_assist/types.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: any;
    };
  }>;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export class OpenAIContentGenerator implements ContentGenerator {
  private apiUrl: string;
  private model: string;
  private apiKey?: string;
  private supportsTools: boolean;
  userTier?: UserTierId;

  constructor(config: {
    apiUrl: string;
    model: string;
    apiKey?: string;
    supportsTools?: boolean;
  }) {
    this.apiUrl = config.apiUrl;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.supportsTools = config.supportsTools ?? false;
  }

  private convertContentToOpenAI(content: ContentListUnion): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    
    // Handle string content
    if (typeof content === 'string') {
      messages.push({
        role: 'user',
        content: content,
      });
      return messages;
    }
    
    // Handle Content array or single Content
    const contentArray = Array.isArray(content) ? content : [content];
    for (const item of contentArray) {
      // Type guard to check if it's a Content object
      if (typeof item === 'object' && 'role' in item && 'parts' in item) {
        const role = item.role === 'model' ? 'assistant' : item.role as any;
        
        if (!item.parts || item.parts.length === 0) {
          continue;
        }

        for (const part of item.parts) {
          if ('text' in part && part.text) {
            messages.push({
              role,
              content: part.text,
            });
          } else if ('functionCall' in part) {
            const fc = part.functionCall as FunctionCall;
            messages.push({
              role: 'assistant',
              tool_calls: [{
                id: `call_${Date.now()}`,
                type: 'function',
                function: {
                  name: fc.name || '',
                  arguments: JSON.stringify(fc.args || {}),
                },
              }],
            });
          } else if ('functionResponse' in part) {
            const fr = part.functionResponse as FunctionResponse;
            messages.push({
              role: 'tool',
              tool_call_id: `call_${Date.now()}`,
              content: JSON.stringify(fr.response),
            });
          }
        }
      }
    }
    
    return messages;
  }

  private createGenerateContentResponse(candidates: Candidate[], promptFeedback: any, usageMetadata?: any): GenerateContentResponse {
    const response = new GenerateContentResponse();
    response.candidates = candidates;
    response.promptFeedback = promptFeedback;
    if (usageMetadata) {
      response.usageMetadata = usageMetadata;
    }
    return response;
  }

  private convertOpenAIToContent(openAIResponse: OpenAIResponse): GenerateContentResponse {
    const parts: Part[] = [];
    
    if (openAIResponse.choices[0]?.message) {
      const message = openAIResponse.choices[0].message;
      
      if (message.content) {
        parts.push({ text: message.content });
      }
      
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }
      }
    }

    const candidates: Candidate[] = [{
      content: {
        role: 'model',
        parts,
      },
      finishReason: (openAIResponse.choices[0]?.finish_reason || 'STOP') as FinishReason,
      index: 0,
    }];

    const usageMetadata = openAIResponse.usage ? {
      promptTokenCount: openAIResponse.usage.prompt_tokens,
      candidatesTokenCount: openAIResponse.usage.completion_tokens,
      totalTokenCount: openAIResponse.usage.total_tokens,
    } : undefined;

    return this.createGenerateContentResponse(candidates, {}, usageMetadata);
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const messages = this.convertContentToOpenAI(request.contents);
    
    const openAIRequest: OpenAIRequest = {
      model: this.model,
      messages,
      temperature: request.config?.temperature,
      top_p: request.config?.topP,
      max_tokens: request.config?.maxOutputTokens,
      stream: false,
    };

    if (this.supportsTools && request.config?.tools) {
      const tools = Array.isArray(request.config.tools) ? request.config.tools : [request.config.tools];
      if (tools.length > 0) {
        openAIRequest.tools = [];
        for (const tool of tools) {
          if (typeof tool === 'object' && 'functionDeclarations' in tool && tool.functionDeclarations) {
            for (const func of tool.functionDeclarations) {
              openAIRequest.tools.push({
                type: 'function',
                function: {
                  name: func.name || '',
                  description: func.description || '',
                  parameters: func.parameters,
                },
              });
            }
          }
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const fetchUrl = `${this.apiUrl}/chat/completions`;
    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAIRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data: OpenAIResponse = await response.json();
    return this.convertOpenAIToContent(data);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.doGenerateContentStream(request, userPromptId);
  }

  private async *doGenerateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): AsyncGenerator<GenerateContentResponse> {
    const messages = this.convertContentToOpenAI(request.contents);
    
    const openAIRequest: OpenAIRequest = {
      model: this.model,
      messages,
      temperature: request.config?.temperature,
      top_p: request.config?.topP,
      max_tokens: request.config?.maxOutputTokens,
      stream: true,
    };

    if (this.supportsTools && request.config?.tools) {
      const tools = Array.isArray(request.config.tools) ? request.config.tools : [request.config.tools];
      if (tools.length > 0) {
        openAIRequest.tools = [];
        for (const tool of tools) {
          if (typeof tool === 'object' && 'functionDeclarations' in tool && tool.functionDeclarations) {
            for (const func of tool.functionDeclarations) {
              openAIRequest.tools.push({
                type: 'function',
                function: {
                  name: func.name || '',
                  description: func.description || '',
                  parameters: func.parameters,
                },
              });
            }
          }
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const fetchUrl = `${this.apiUrl}/chat/completions`;
    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAIRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedContent = '';
    const toolCalls: Map<number, any> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const chunk: OpenAIStreamChunk = JSON.parse(data);
            
            if (chunk.choices[0]?.delta) {
              const delta = chunk.choices[0].delta;
              
              if (delta.content) {
                accumulatedContent += delta.content;
                const candidates: Candidate[] = [{
                  content: {
                    role: 'model',
                    parts: [{ text: accumulatedContent }],
                  },
                  finishReason: (chunk.choices[0].finish_reason || undefined) as FinishReason | undefined,
                  index: 0,
                }];
                yield this.createGenerateContentResponse(candidates, {});
              }
              
              if (delta.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  if (!toolCalls.has(toolCall.index)) {
                    toolCalls.set(toolCall.index, {
                      id: toolCall.id || '',
                      type: toolCall.type || 'function',
                      function: {
                        name: toolCall.function?.name || '',
                        arguments: '',
                      },
                    });
                  }
                  
                  const existing = toolCalls.get(toolCall.index);
                  if (toolCall.function?.name) {
                    existing.function.name = toolCall.function.name;
                  }
                  if (toolCall.function?.arguments) {
                    existing.function.arguments += toolCall.function.arguments;
                  }
                }
              }
            }
          } catch (e) {
            console.error('Error parsing SSE chunk:', e);
          }
        }
      }
    }

    if (toolCalls.size > 0) {
      const parts: Part[] = [];
      if (accumulatedContent) {
        parts.push({ text: accumulatedContent });
      }
      
      for (const toolCall of toolCalls.values()) {
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments),
          },
        });
      }
      
      const candidates: Candidate[] = [{
        content: {
          role: 'model',
          parts,
        },
        finishReason: 'STOP' as FinishReason,
        index: 0,
      }];
      yield this.createGenerateContentResponse(candidates, {});
    }
  }

  async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    let text = '';
    
    if (typeof request.contents === 'string') {
      text = request.contents;
    } else if (Array.isArray(request.contents)) {
      text = request.contents
        .filter((c): c is Content => typeof c === 'object' && 'parts' in c)
        .map(c => 
          c.parts ? c.parts.map((p: any) => 'text' in p ? p.text : '').join(' ') : ''
        ).join(' ');
    } else if (typeof request.contents === 'object' && 'parts' in request.contents) {
      text = request.contents.parts ? request.contents.parts.map((p: any) => 'text' in p ? p.text : '').join(' ') : '';
    }
    
    const estimatedTokens = Math.ceil(text.length / 4);
    
    return {
      totalTokens: estimatedTokens,
      cachedContentTokenCount: 0,
    };
  }

  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    throw new Error('Embeddings not supported for OpenAI-compatible API');
  }
}