/**
 * Constants for the session-replay feature.
 *
 * Extracted from SessionReplay.tsx (Cluster A2 split).
 *
 * @module components/session-replay/constants
 */

import { Dimensions } from 'react-native';
import type { PlaybackSpeed } from './types';

/** Selectable playback speeds, slowest to fastest. */
export const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4];

/** Screen width, used to map a progress-bar tap to a playback position. */
export const { width: SCREEN_WIDTH } = Dimensions.get('window');
