import type {
  SubtitleDiagnosticDetailValue,
  SubtitleDiagnosticErrorCode,
  SubtitleDiagnosticErrorLike,
  SubtitleDiagnosticWarning,
  SubtitleDiagnosticWarningCode,
  SubtitleFormatName
} from './types'

interface SubtitleDiagnosticContext {
  format?: SubtitleFormatName
  details?: Record<string, SubtitleDiagnosticDetailValue>
  fallbackCode?: SubtitleDiagnosticErrorCode
}

export class SubtitleDiagnosticError extends Error implements SubtitleDiagnosticErrorLike {
  readonly code: SubtitleDiagnosticErrorCode
  readonly format?: SubtitleFormatName
  readonly details?: Record<string, SubtitleDiagnosticDetailValue>
  override readonly cause?: unknown

  constructor(
    code: SubtitleDiagnosticErrorCode,
    message: string,
    options: {
      format?: SubtitleFormatName
      details?: Record<string, SubtitleDiagnosticDetailValue>
      cause?: unknown
    } = {}
  ) {
    super(message)
    this.name = 'SubtitleDiagnosticError'
    this.code = code
    this.format = options.format
    this.details = options.details
    this.cause = options.cause
  }
}

export function createSubtitleDiagnosticError(
  code: SubtitleDiagnosticErrorCode,
  message: string,
  options: {
    format?: SubtitleFormatName
    details?: Record<string, SubtitleDiagnosticDetailValue>
    cause?: unknown
  } = {}
): SubtitleDiagnosticError {
  return new SubtitleDiagnosticError(code, message, options)
}

export function normalizeSubtitleError(
  error: unknown,
  context: SubtitleDiagnosticContext = {}
): SubtitleDiagnosticError {
  if (error instanceof SubtitleDiagnosticError) {
    return error
  }

  const resolvedError = error instanceof Error ? error : new Error(String(error))
  const code = inferSubtitleDiagnosticErrorCode(resolvedError.message, context.fallbackCode)

  return new SubtitleDiagnosticError(code, resolvedError.message, {
    format: context.format,
    details: context.details,
    cause: error
  })
}

export function createSubtitleWarning(
  code: SubtitleDiagnosticWarningCode,
  message: string,
  options: {
    format?: SubtitleFormatName
    cueIndex?: number
    details?: Record<string, SubtitleDiagnosticDetailValue>
  } = {}
): SubtitleDiagnosticWarning {
  return {
    code,
    message,
    format: options.format,
    cueIndex: options.cueIndex,
    details: options.details
  }
}

export function warningFromRenderIssue(
  renderIssue: string | null | undefined,
  options: {
    format?: SubtitleFormatName
    cueIndex?: number
  } = {}
): SubtitleDiagnosticWarning | null {
  const normalizedIssue = renderIssue?.trim().toUpperCase()
  if (!normalizedIssue) return null

  switch (normalizedIssue) {
    case 'MISSING_PALETTE':
      return createSubtitleWarning('MISSING_PALETTE', 'PGS cue references a palette that was not available at render time.', {
        format: options.format,
        cueIndex: options.cueIndex
      })
    case 'INVALID_PACKET':
      return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle packet could not be decoded for the requested cue.', {
        format: options.format,
        cueIndex: options.cueIndex
      })
    case 'RENDER_CONTEXT_UNAVAILABLE':
      return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle render context could not be assembled for the requested cue.', {
        format: options.format,
        cueIndex: options.cueIndex
      })
    case 'EMPTY_RENDER':
      return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle cue rendered without any visible bitmap data.', {
        format: options.format,
        cueIndex: options.cueIndex
      })
    default:
      return null
  }
}

export function formatSubtitleWarningForConsole(warning: SubtitleDiagnosticWarning): string {
  return `[libbitsub:${warning.code}] ${warning.message}`
}

function inferSubtitleDiagnosticErrorCode(
  message: string,
  fallbackCode: SubtitleDiagnosticErrorCode = 'UNKNOWN'
): SubtitleDiagnosticErrorCode {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('detect subtitle format') || normalizedMessage.includes('unsupported format')) {
    return 'UNSUPPORTED_FORMAT'
  }

  if (normalizedMessage.includes('no s_vobsub track') || normalizedMessage.includes('track not found')) {
    return 'TRACK_NOT_FOUND'
  }

  if (
    normalizedMessage.includes('idx') ||
    normalizedMessage.includes('codecprivate') ||
    normalizedMessage.includes('filepos')
  ) {
    return 'BAD_IDX'
  }

  if (normalizedMessage.includes('palette')) {
    return 'MISSING_PALETTE'
  }

  if (normalizedMessage.includes('failed to fetch')) {
    return 'FETCH_FAILED'
  }

  if (normalizedMessage.includes('no ') && normalizedMessage.includes('provided')) {
    return 'MISSING_INPUT'
  }

  if (
    normalizedMessage.includes('invalid') ||
    normalizedMessage.includes('truncated') ||
    normalizedMessage.includes('malformed') ||
    normalizedMessage.includes('subtitle block') ||
    normalizedMessage.includes('payload')
  ) {
    return 'INVALID_SUBTITLE_DATA'
  }

  return fallbackCode
}