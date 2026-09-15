// ESLint flat config — dev tool only, NOT a build step.
// Classic <script> files share global scope in the browser, so
// no-undef is a warning (not an error) for UI modules.

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        document: 'readonly',
        window: 'readonly',
        Worker: 'readonly',
        EventSource: 'readonly',
        AudioContext: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        FormData: 'readonly',
        URLSearchParams: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        speechSynthesis: 'readonly',
        webkitAudioContext: 'readonly',
        XMLHttpRequest: 'readonly'
      }
    },
    rules: {
      'no-undef': 'warn',
      'no-unused-vars': 'warn',
      'no-redeclare': 'warn',
      'no-cond-assign': 'error',
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-empty': 'warn',
      'no-extra-semi': 'error',
      'no-irregular-whitespace': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error'
    }
  },
  {
    files: ['server.js', 'engine.js', 'referee-service.js', 'rules-engine.js', 'game-archive.js', 'bot-service.js', 'stockfish-worker.js', 'move-review.js', 'seat-auth.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        document: 'readonly',
        window: 'readonly',
        Worker: 'readonly',
        EventSource: 'readonly'
      }
    }
  },
  {
    files: ['**/*-selftest.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  },
  {
    ignores: ['node_modules/**', '.agent-grid/**']
  }
];