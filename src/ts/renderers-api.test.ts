import { describe, expect, test } from 'bun:test'

import { DvbRenderer, PgsRenderer, VobSubRenderer } from './renderers'

describe('live renderer API', () => {
  test('is exposed by PGS and DVB renderers only', () => {
    for (const renderer of [PgsRenderer, DvbRenderer]) {
      expect(typeof renderer.prototype.append).toBe('function')
      expect(typeof renderer.prototype.flush).toBe('function')
      expect(typeof renderer.prototype.reset).toBe('function')
    }

    expect('append' in VobSubRenderer.prototype).toBe(false)
    expect('flush' in VobSubRenderer.prototype).toBe(false)
    expect('reset' in VobSubRenderer.prototype).toBe(false)
  })
})
