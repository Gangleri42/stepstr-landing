// The SO-101 page's model and storyboard, which src/main.ts loads for <html data-subject="so101">. The
// storyboard stays free of the virtual module, so the tests can import it without the landing build's plugin.
import { model, webOrigin } from 'virtual:landing-model/so101';
import type { Subject } from '../../src/stage.ts';
import { HANDOFF_AT, STORYBOARD } from './storyboard.ts';

export const subject: Subject = { model, webOrigin, storyboard: STORYBOARD, handoffAt: HANDOFF_AT };
