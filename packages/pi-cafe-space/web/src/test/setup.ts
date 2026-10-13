import * as matchers from '@testing-library/jest-dom/matchers';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
// Register on this workspace's Vitest 4 expect, not the hoisted Vitest 3 peer
// that a dependency's /vitest entry could resolve from the workspace root.
expect.extend(matchers);
afterEach(() => { cleanup(); window.location.hash = ''; });
