import { AISettings, AIProvider } from '@/types';
import { getKnowledgeFile } from './db';

/**
 * Generates an AI response using the provided settings and incoming user text.
 * Falls back to a simple default string if OPENAI_API_KEY is not set.
 */
export async function generateAIResponse(userText: string, settings: AISettings): Promise<string> {
  console.log('=== AI RESPONSE GENERATION START ===');
  console.log('User text:', userText);
  console.log('Settings:', JSON.stringify(settings, null, 2));
  
  const provider: AIProvider = settings.provider || 'openai';
  console.log('Using provider:', provider);

  const apiKey = settings.apiKey ||
    (provider === 'openai' ? process.env.OPENAI_API_KEY :
     provider === 'gemini' ? process.env.GEMINI_API_KEY :
     process.env.ANTHROPIC_API_KEY);

  console.log('API key available:', !!apiKey);
  if (!apiKey) {
    console.warn(`${provider} API key not set; returning fallback message.`);
    return 'Sorry, I cannot respond right now.';
  }
  // Gather knowledge context
  let context = '';
  if (settings.knowledgeFileIds?.length) {
    const files = await Promise.all(settings.knowledgeFileIds.map(getKnowledgeFile));
    context = files
      .filter(Boolean)
      .map(f => `Content from ${f!.fileName}:\n${f!.content}`)
      .join('\n\n---\n\n');
  }

  const systemPrompt = settings.systemPrompt || 'You are a helpful WhatsApp assistant.';
  
  // Log the knowledge context for debugging
  console.log('Knowledge context available:', !!context, context ? `(${context.length} chars)` : '');
  
  // Create different prompt formats based on provider
  // Define the type for OpenAI/Anthropic message format
  type PromptMessage = { role: string; content: string };
  
  // Initialize with proper typing
  let prompt: PromptMessage[] = [];
  
  if (provider === 'gemini') {
    // Gemini prompt is handled directly in the Gemini case
    // Keep prompt as empty array
  } else {
    // For OpenAI and Anthropic
    prompt = [
      { role: 'system', content: systemPrompt },
      // Only include knowledge context if it exists
      ...(context ? [{ role: 'system', content: `Use the following knowledge when helpful:\n${context}` }] : []),
      { role: 'user', content: userText },
    ];
  }

  // Call appropriate provider
  try {
    let responseText = '';

    switch (provider) {
      case 'openai': {
        // For OpenAI, we need to format the messages array correctly
        // Initialize with the system prompt
        const messages = [
          { role: 'system', content: systemPrompt }
        ];
        
        // If we have knowledge context, add it as a system message
        if (context) {
          messages.push({ 
            role: 'system', 
            content: `Use the following knowledge when answering the user's question:\n${context}` 
          });
        }
        
        // Add the user's query
        messages.push({ role: 'user', content: userText });
        
        console.log('OpenAI API request:', JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: messages,
          max_tokens: Math.min(Math.floor(settings.maxLen / 4), 500),
          temperature: settings.temperature,
        }, null, 2));
        
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: messages,
            max_tokens: Math.min(Math.floor(settings.maxLen / 4), 500),
            temperature: settings.temperature,
          }),
        });
        const data = await resp.json();
        console.log('OpenAI API response:', JSON.stringify(data, null, 2));
        responseText = data.choices?.[0]?.message?.content?.trim() || '';
        break;
      }
      case 'gemini': {
        // Using the v1beta endpoint with gemini-2.0-flash, as per the user's curl example.
        // The system prompt, context, and user query are combined into a single text block.
        let combinedPrompt = systemPrompt;
        if (context) {
          combinedPrompt += `\n\nUse the following reference information to answer the user's query:\n\n${context}`;
        }
        combinedPrompt += `\n\nUser query: ${userText}`;

        // The v1beta payload structure is simpler and doesn't use roles within contents.
        const contents = [{
          parts: [{ text: combinedPrompt }]
        }];

        const requestBody = {
          contents,
          generationConfig: {
            maxOutputTokens: settings.maxLen,
            temperature: settings.temperature,
          },
        };

        console.log('Gemini API request:', JSON.stringify(requestBody, null, 2));
        
        const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        let data: any;
        try {
          data = await resp.json();
        } catch (err) {
          const raw = await resp.text();
          console.error('Gemini API raw response (non-JSON):', raw);
          throw new Error(raw);
        }
        
        console.log('Gemini API response:', JSON.stringify(data, null, 2));
        
        if (data.error) {
          console.error('Gemini API Error:', data.error.message);
          responseText = '';
        } else {
          responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        }
        
        break;
      }
      case 'anthropic': {
        // Format messages for Anthropic API
        // Claude expects system prompts to be in a special format
        // and user messages in a specific array
        
        // Create a system prompt that includes knowledge context if available
        let enhancedSystemPrompt = systemPrompt;
        if (context) {
          enhancedSystemPrompt = `${systemPrompt}\n\nUse the following knowledge base to answer the user's questions:\n${context}`;
        }
        
        // Format the user message
        const userMessages = [
          { role: 'user', content: userText }
        ];
        
        console.log('Anthropic API request:', JSON.stringify({
          model: 'claude-3-sonnet-20240229',
          max_tokens: Math.min(settings.maxLen, 1000),
          temperature: settings.temperature,
          system: enhancedSystemPrompt,
          messages: userMessages
        }, null, 2));
        
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-sonnet-20240229',
            max_tokens: Math.min(settings.maxLen, 1000),
            temperature: settings.temperature,
            system: enhancedSystemPrompt,
            messages: userMessages,
          }),
        });
        const data = await resp.json();
        console.log('Anthropic API response:', JSON.stringify(data, null, 2));
        responseText = data.content?.[0]?.text?.trim() || '';
        break;
      }
      default:
        responseText = '';
    }

    console.log('=== AI RESPONSE GENERATION END ===');
    console.log('Final response text:', responseText);
    const finalResponse = responseText || 'Sorry, I am unable to help at the moment.';
    console.log('Returning response:', finalResponse);
    return finalResponse;
  } catch (err) {
    console.error('AI provider call failed:', err);
    console.log('=== AI RESPONSE GENERATION FAILED ===');
    return 'Sorry, I ran into a problem.';
  }
}
