/**
 * Diff Processor for Gemini - Handles file edit events and tracks unified_diff changes
 * 
 * This processor tracks changes from fs-edit events and tool_call results that contain
 * file modification information, converting them to GeminiDiff tool calls similar to Codex.
 * 
 * Note: Gemini ACP doesn't have direct turn_diff events like Codex, so we track
 * file changes through fs-edit events and tool results that may contain diff information.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'GeminiDiff';
    callId: string;
    input: {
        unified_diff?: string;
        path?: string;
        description?: string;
    };
    id: string;
}

export interface DiffToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        status: 'completed';
    };
    id: string;
}

export class GeminiDiffProcessor {
    private previousDiffs = new Map<string, string>(); // Track diffs per file path
    private onMessage: ((message: DiffToolCall | DiffToolResult) => void) | null = null;

    constructor(onMessage?: (message: DiffToolCall | DiffToolResult) => void) {
        this.onMessage = onMessage || null;
    }

    /**
     * Process an fs-edit event and check if it contains diff information
     */
    processFsEdit(path: string, description?: string, diff?: string): void {
        logger.debug(`[GeminiDiffProcessor] Processing fs-edit for path: ${path}`);
        
        // If we have a diff, process it
        if (diff) {
            this.processDiff(path, diff, description);
        } else {
            // Even without diff, we can track that a file was edited
            // Generate a simple diff representation
            const simpleDiff = `File edited: ${path}${description ? ` - ${description}` : ''}`;
            this.processDiff(path, simpleDiff, description);
        }
    }

    /**
     * Process a tool result that may contain diff information.
     *
     * @param toolName - Name of the tool that produced the result
     * @param result - Arbitrary tool result object (shape varies by tool)
     * @param callId - The tool call ID for correlation
     */
    processToolResult(toolName: string, result: unknown, callId: string): void {
        // Check if result contains diff information
        if (result && typeof result === 'object') {
            const resultObj = result as Record<string, unknown>;
            // Look for common diff fields
            const diff = resultObj['diff'] || resultObj['unified_diff'] || resultObj['patch'];
            const path = resultObj['path'] || resultObj['file'];

            if (typeof diff === 'string' && typeof path === 'string') {
                logger.debug(`[GeminiDiffProcessor] Found diff in tool result: ${toolName} (${callId})`);
                const description = typeof resultObj['description'] === 'string' ? resultObj['description'] : undefined;
                this.processDiff(path, diff, description);
            } else if (resultObj['changes'] && typeof resultObj['changes'] === 'object') {
                // Handle multiple file changes (like patch operations)
                for (const [filePath, change] of Object.entries(resultObj['changes'] as Record<string, unknown>)) {
                    if (change && typeof change === 'object') {
                        const changeObj = change as Record<string, unknown>;
                        const changeDiff = typeof changeObj['diff'] === 'string' ? changeObj['diff'] :
                                           typeof changeObj['unified_diff'] === 'string' ? changeObj['unified_diff'] :
                                           JSON.stringify(change);
                        const changeDesc = typeof changeObj['description'] === 'string' ? changeObj['description'] : undefined;
                        this.processDiff(filePath, changeDiff, changeDesc);
                    }
                }
            }
        }
    }

    /**
     * Process a unified diff and check if it has changed from the previous value
     */
    private processDiff(path: string, unifiedDiff: string, description?: string): void {
        const previousDiff = this.previousDiffs.get(path);
        
        // Check if the diff has changed from the previous value
        if (previousDiff !== unifiedDiff) {
            logger.debug(`[GeminiDiffProcessor] Unified diff changed for ${path}, sending GeminiDiff tool call`);
            
            // Generate a unique call ID for this diff
            const callId = randomUUID();
            
            // Send tool call for the diff change
            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'GeminiDiff',
                callId: callId,
                input: {
                    unified_diff: unifiedDiff,
                    path: path,
                    description: description
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolCall);
            
            // Immediately send the tool result to mark it as completed
            const toolResult: DiffToolResult = {
                type: 'tool-call-result',
                callId: callId,
                output: {
                    status: 'completed'
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolResult);
        }
        
        // Update the stored diff value
        this.previousDiffs.set(path, unifiedDiff);
        logger.debug(`[GeminiDiffProcessor] Updated stored diff for ${path}`);
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[GeminiDiffProcessor] Resetting diff state');
        this.previousDiffs.clear();
    }

    /**
     * Set the message callback for sending messages directly.
     *
     * @param callback - Function to receive diff tool call/result messages
     */
    setMessageCallback(callback: (message: DiffToolCall | DiffToolResult) => void): void {
        this.onMessage = callback;
    }

    /**
     * Get the current diff value for a specific path
     */
    getCurrentDiff(path: string): string | null {
        return this.previousDiffs.get(path) || null;
    }

    /**
     * Get all tracked diffs
     */
    getAllDiffs(): Map<string, string> {
        return new Map(this.previousDiffs);
    }
}
