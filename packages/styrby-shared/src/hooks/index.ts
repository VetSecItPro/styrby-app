/**
 * Hooks barrel — platform-agnostic primitives for realtime subscriptions.
 *
 * React/RN consumers wrap these with their platform's lifecycle hook
 * (`useEffect` / `useFocusEffect`) so the cleanup runs on unmount.
 *
 * @module hooks
 */

export * from './realtime-factory.js';
