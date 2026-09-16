import { describe, it, expect } from 'vitest';
import { assertNever } from '../src/types';

describe('assertNever', () => {
  it('throws with the unhandled value serialized in the message', () => {
    // @ts-expect-error deliberately passing a non-never value to exercise the runtime guard
    expect(() => assertNever('unexpected')).toThrow('Unhandled case: "unexpected"');
  });
});
