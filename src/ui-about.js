/**
 * ui-about.js
 * Static editorial About view for the site shell.
 *
 * This module is display-only. It describes the product without reading or
 * deriving any live game data.
 */

(function () {
  'use strict';

  const state = {
    el: null,
    mounted: false
  };

  function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('about-view-styles')) return;

    const style = document.createElement('style');
    style.id = 'about-view-styles';
    style.textContent = `
      .about-page {
        width: min(100%, 960px);
        margin: 0 auto;
        padding: clamp(36px, 7vw, 80px) 20px 48px;
        color: var(--text-color);
      }
      .about-section {
        margin-top: clamp(64px, 10vw, 108px);
      }
      .about-hero {
        max-width: 820px;
        padding-bottom: clamp(48px, 8vw, 80px);
        border-bottom: 1px solid var(--panel-border);
      }
      .about-eyebrow,
      .about-version,
      .about-stat-label,
      .about-stat-detail,
      .about-mechanism,
      .about-summary,
      .about-footer-note {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .about-eyebrow {
        margin: 0 0 18px;
        color: var(--accent);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.16em;
        line-height: 1.5;
        text-transform: uppercase;
      }
      .about-page h1,
      .about-page h2,
      .about-footer-title {
        font-family: var(--display-font, Georgia, "Times New Roman", serif);
        font-weight: 400;
        letter-spacing: -0.035em;
        text-wrap: balance;
      }
      .about-page h1 {
        max-width: 790px;
        margin: 0;
        font-size: clamp(3rem, 7.5vw, 6.4rem);
        line-height: 0.94;
      }
      .about-page h2,
      .about-footer-title {
        max-width: 720px;
        margin: 0;
        font-size: clamp(2.25rem, 5vw, 4.25rem);
        line-height: 1;
      }
      .about-intro {
        max-width: 680px;
        margin: 28px 0 0;
        color: var(--muted);
        font-size: clamp(1.05rem, 2vw, 1.25rem);
        line-height: 1.7;
      }
      .about-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 30px;
      }
      .about-action {
        display: inline-flex;
        min-height: 44px;
        align-items: center;
        justify-content: center;
        padding: 10px 17px;
        border: 1px solid var(--panel-border);
        border-radius: 4px;
        background: var(--panel-bg);
        color: var(--text-color);
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        text-decoration: none;
        transition: background-color 150ms, border-color 150ms, color 150ms;
      }
      .about-action:hover {
        border-color: var(--accent);
        background: var(--accent-soft, var(--panel-bg));
      }
      .about-action-primary {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--panel-bg);
      }
      .about-action-primary:hover {
        background: var(--text-color);
        color: var(--panel-bg);
      }
      .about-version {
        margin: 20px 0 0;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.08em;
      }
      .about-feature-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border-top: 1px solid var(--panel-border);
        border-left: 1px solid var(--panel-border);
      }
      .about-feature-card {
        min-height: 156px;
        padding: 24px;
        border-right: 1px solid var(--panel-border);
        border-bottom: 1px solid var(--panel-border);
        background: var(--card-bg);
      }
      .about-feature-card h2,
      .about-property-card h3 {
        font-family: var(--display-font, Georgia, "Times New Roman", serif);
        font-weight: 400;
        letter-spacing: -0.02em;
      }
      .about-feature-card h2 {
        margin: 0;
        font-size: 1.5rem;
        line-height: 1.15;
      }
      .about-feature-card p,
      .about-property-card p,
      .about-layer-list p,
      .about-faq p,
      .about-section-intro {
        color: var(--muted);
        line-height: 1.65;
      }
      .about-feature-card p {
        margin: 12px 0 0;
        font-size: 0.9rem;
      }
      .about-stats-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        border-top: 1px solid var(--panel-border);
        border-left: 1px solid var(--panel-border);
      }
      .about-stat-card {
        min-height: 176px;
        padding: 24px 20px;
        border-right: 1px solid var(--panel-border);
        border-bottom: 1px solid var(--panel-border);
        background: var(--card-bg);
      }
      .about-stat-value {
        display: block;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: clamp(2.25rem, 5vw, 4rem);
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        letter-spacing: -0.06em;
        line-height: 1;
      }
      .about-stat-label {
        display: block;
        margin-top: 20px;
        color: var(--text-color);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .about-stat-detail {
        display: block;
        margin-top: 7px;
        color: var(--muted);
        font-size: 10px;
        line-height: 1.5;
      }
      .about-section-heading {
        display: grid;
        grid-template-columns: minmax(0, 0.78fr) minmax(260px, 1.22fr);
        gap: 36px;
        align-items: end;
        margin-bottom: 32px;
      }
      .about-section-heading .about-section-intro {
        max-width: 560px;
        margin: 0;
      }
      .about-property-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .about-property-card {
        display: flex;
        min-height: 250px;
        flex-direction: column;
        padding: 28px;
        border: 1px solid var(--panel-border);
        border-left: 3px solid var(--accent);
        background: var(--card-bg);
      }
      .about-property-card h3 {
        margin: 0;
        font-size: 1.75rem;
        line-height: 1.1;
      }
      .about-property-card p {
        margin: 18px 0 24px;
        font-size: 0.95rem;
      }
      .about-mechanism {
        margin-top: auto;
        color: var(--accent);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.08em;
        line-height: 1.6;
        text-transform: uppercase;
      }
      .about-table-wrap {
        overflow-x: auto;
        border: 1px solid var(--panel-border);
        background: var(--panel-bg);
      }
      .about-table {
        width: 100%;
        border-collapse: collapse;
        color: var(--text-color);
        font-size: 0.9rem;
      }
      .about-table th,
      .about-table td {
        padding: 16px 18px;
        border-bottom: 1px solid var(--panel-border);
        text-align: left;
        vertical-align: top;
      }
      .about-table th {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }
      .about-table td:first-child {
        width: 31%;
        font-weight: 600;
      }
      .about-table tbody tr:last-child td {
        border-bottom: 0;
      }
      .about-stack-table td:nth-child(1) {
        width: 22%;
      }
      .about-stack-table td:nth-child(2) {
        width: 31%;
        font-weight: 600;
      }
      .about-stack-table td:nth-child(3) {
        color: var(--muted);
      }
      .about-layers {
        margin-top: 36px;
        padding: 28px;
        border: 1px solid var(--panel-border);
        background: var(--card-bg);
      }
      .about-layers h3 {
        margin: 0 0 20px;
        font-family: var(--display-font, Georgia, "Times New Roman", serif);
        font-size: 1.75rem;
        font-weight: 400;
      }
      .about-layer-list {
        margin: 0;
        padding: 0;
        list-style: none;
        counter-reset: about-layer;
      }
      .about-layer-list li {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 14px;
        padding: 18px 0;
        border-top: 1px solid var(--panel-border);
        counter-increment: about-layer;
      }
      .about-layer-list li::before {
        content: counter(about-layer, decimal-leading-zero);
        color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
      }
      .about-layer-list strong {
        display: block;
        font-size: 0.95rem;
      }
      .about-layer-list p {
        margin: 5px 0 0;
        font-size: 0.9rem;
      }
      .about-summary {
        margin: 24px 0 0;
        color: var(--accent);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        line-height: 1.7;
        text-transform: uppercase;
      }
      .about-gallery {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .about-figure {
        margin: 0;
        border: 1px solid var(--panel-border);
        background: var(--card-bg);
      }
      .about-figure img {
        display: block;
        width: 100%;
        min-height: 220px;
        aspect-ratio: 4 / 3;
        object-fit: cover;
        border-bottom: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg) 88%, var(--accent));
      }
      .about-figure figcaption {
        padding: 14px 16px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }
      .about-faq-list {
        border-top: 1px solid var(--panel-border);
      }
      .about-faq {
        border-right: 1px solid var(--panel-border);
        border-bottom: 1px solid var(--panel-border);
        border-left: 1px solid var(--panel-border);
        background: var(--card-bg);
      }
      .about-faq summary {
        position: relative;
        padding: 20px 54px 20px 20px;
        cursor: pointer;
        font-family: var(--display-font, Georgia, "Times New Roman", serif);
        font-size: 1.3rem;
        list-style: none;
      }
      .about-faq summary::-webkit-details-marker {
        display: none;
      }
      .about-faq summary::after {
        content: '+';
        position: absolute;
        top: 50%;
        right: 20px;
        color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        transform: translateY(-50%);
      }
      .about-faq[open] summary::after {
        content: '\u2212';
      }
      .about-faq p {
        max-width: 760px;
        margin: 0;
        padding: 0 54px 22px 20px;
        font-size: 0.92rem;
      }
      .about-footer-cta {
        margin-top: clamp(72px, 11vw, 120px);
        padding-top: clamp(42px, 7vw, 68px);
        border-top: 1px solid var(--panel-border);
      }
      .about-footer-note {
        margin: 22px 0 0;
        color: var(--muted);
        font-size: 10px;
        letter-spacing: 0.08em;
        line-height: 1.6;
        text-transform: uppercase;
      }
      @media (max-width: 760px) {
        .about-page {
          padding-inline: 4px;
        }
        .about-feature-grid,
        .about-property-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .about-stats-grid,
        .about-gallery {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .about-section-heading {
          grid-template-columns: 1fr;
          align-items: start;
        }
        .about-gallery .about-figure:first-child {
          grid-column: 1 / -1;
        }
      }
      @media (max-width: 560px) {
        .about-feature-grid,
        .about-property-grid,
        .about-gallery {
          grid-template-columns: 1fr;
        }
        .about-gallery .about-figure:first-child {
          grid-column: auto;
        }
        .about-feature-card,
        .about-property-card {
          min-height: 0;
        }
        .about-table-wrap {
          border: 0;
          background: transparent;
          overflow: visible;
        }
        .about-table,
        .about-table tbody,
        .about-table tr,
        .about-table td {
          display: block;
          width: 100% !important;
        }
        .about-table thead {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip-path: inset(50%);
        }
        .about-table tr {
          margin-bottom: 10px;
          border: 1px solid var(--panel-border);
          background: var(--card-bg);
        }
        .about-table td {
          padding: 12px 14px;
        }
        .about-table td::before {
          content: attr(data-label);
          display: block;
          margin-bottom: 5px;
          color: var(--muted);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .about-table tbody tr:last-child td:not(:last-child) {
          border-bottom: 1px solid var(--panel-border);
        }
        .about-table td:last-child {
          border-bottom: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderSkeleton(el) {
    el.innerHTML = `
      <article class="about-page">
        <header class="about-hero" data-about-section="header">
          <p class="about-eyebrow">A chess site where the referee has no UI</p>
          <h1>A chess board backed by one authoritative referee.</h1>
          <p class="about-intro">Play, study, and improve in a quiet chess space designed around one clear principle: the board you see always comes from the same source of truth.</p>
          <div class="about-actions">
            <button class="about-action about-action-primary" type="button" data-about-action="play">Start a game</button>
            <a class="about-action" href="https://chess-game-0zax.onrender.com" target="_blank" rel="noopener">Open live site</a>
          </div>
          <p class="about-version">v1.0.0</p>
        </header>

        <section class="about-section" data-about-section="features" aria-label="Chess features">
          <div class="about-feature-grid">
            <article class="about-feature-card"><h2>Play</h2><p>Play against eight built-in bot levels spanning roughly 800–2300 strength.</p></article>
            <article class="about-feature-card"><h2>Puzzles</h2><p>Train with 8,861 real lichess positions across focused tactical modes.</p></article>
            <article class="about-feature-card"><h2>Analysis</h2><p>Study engine lines, evaluation shifts, and tablebase-perfect endings.</p></article>
            <article class="about-feature-card"><h2>Library</h2><p>Import games and keep a personal collection ready for review.</p></article>
            <article class="about-feature-card"><h2>Insights &amp; ratings</h2><p>Follow playing trends and ratings tuned to each time control.</p></article>
            <article class="about-feature-card"><h2>Coordinates trainer</h2><p>Build board vision by finding named squares against the clock.</p></article>
          </div>
        </section>

        <section class="about-section" data-about-section="stats" aria-label="Chess site statistics">
          <div class="about-stats-grid">
            <article class="about-stat-card"><span class="about-stat-value">78</span><span class="about-stat-label">Unit suites run</span><span class="about-stat-detail">In the full unit check</span></article>
            <article class="about-stat-card"><span class="about-stat-value">8,861</span><span class="about-stat-label">Puzzles</span><span class="about-stat-detail">Real lichess positions</span></article>
            <article class="about-stat-card"><span class="about-stat-value">8</span><span class="about-stat-label">Bot levels</span><span class="about-stat-detail">About 800–2300</span></article>
            <article class="about-stat-card"><span class="about-stat-value">200</span><span class="about-stat-label">Games replayed</span><span class="about-stat-detail">Per differential run</span></article>
          </div>
        </section>

        <section class="about-section" data-about-section="properties">
          <div class="about-section-heading">
            <h2>Why a normal chess UI is not enough</h2>
            <p class="about-section-intro">A convincing board is easy to draw. The harder problem is making every move, clock, reconnect, and identity agree under real use. These properties keep the experience coherent.</p>
          </div>
          <div class="about-property-grid">
            <article class="about-property-card">
              <h3>One referee per room</h3>
              <p>Every room has one authority for its board, clocks, history, and result. Every mutation is serialized through a single FIFO command queue, so simultaneous actions resolve in one dependable order.</p>
              <span class="about-mechanism">Mechanism · single authority + FIFO queue</span>
            </article>
            <article class="about-property-card">
              <h3>Recovery is part of play</h3>
              <p>An append-only journal records accepted changes while an atomic snapshot keeps a compact current state. After a crash, replay restores the room without asking the browser to reconstruct the game.</p>
              <span class="about-mechanism">Mechanism · journal + atomic snapshot + replay</span>
            </article>
            <article class="about-property-card">
              <h3>One live stream</h3>
              <p>Updates arrive over a single Server-Sent Events stream. The browser re-renders from authoritative state instead of maintaining a competing version of the position.</p>
              <span class="about-mechanism">Mechanism · SSE + render from truth</span>
            </article>
            <article class="about-property-card">
              <h3>A seat is an identity</h3>
              <p>Signed seat tokens bind a player to a side. A move can only be made by the person who holds that seat, keeping spectators and opponents outside the mutation boundary.</p>
              <span class="about-mechanism">Mechanism · signed seat tokens</span>
            </article>
          </div>
        </section>

        <section class="about-section" data-about-section="technologies">
          <div class="about-section-heading">
            <h2>Technologies used</h2>
            <p class="about-section-intro">A deliberately small web stack, with dedicated components only where chess rules, evaluation, identity, or durable storage need them.</p>
          </div>
          <div class="about-table-wrap">
            <table class="about-table">
              <thead><tr><th scope="col">Technology</th><th scope="col">What it’s for</th></tr></thead>
              <tbody>
                <tr><td data-label="Technology">Plain JavaScript + Node.js</td><td data-label="What it’s for">The client and server run without a framework, bundler, or build step.</td></tr>
                <tr><td data-label="Technology">Move generation + chess.js</td><td data-label="What it’s for">In-house move generation is paired with a chess.js adapter for independent rules validation.</td></tr>
                <tr><td data-label="Technology">Stockfish 19 lite</td><td data-label="What it’s for">Single-threaded WebAssembly under GPL-3.0, running in a browser Web Worker for analysis and a server-side worker thread for bots.</td></tr>
                <tr><td data-label="Technology">Server-Sent Events</td><td data-label="What it’s for">One-way realtime room updates over a durable browser-native stream.</td></tr>
                <tr><td data-label="Technology">SQLite + JSON fallback</td><td data-label="What it’s for">Durable game, puzzle, rating, and account data through node:sqlite, with JSON available as a fallback.</td></tr>
                <tr><td data-label="Technology">scrypt + signed tokens</td><td data-label="What it’s for">Password hashing and seat identity, with optional Google sign-in for accounts.</td></tr>
                <tr><td data-label="Technology">Glicko-2</td><td data-label="What it’s for">A separate playing rating for each time control, plus an independent puzzle rating.</td></tr>
                <tr><td data-label="Technology">Open chess data</td><td data-label="What it’s for">CC0-licensed lichess puzzles and openings data, with cburnett artwork for the pieces.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="about-section" data-about-section="architecture">
          <p class="about-eyebrow">Responsibilities, without the diagram fog</p>
          <div class="about-section-heading">
            <h2>How it’s put together</h2>
            <p class="about-section-intro">Each layer carries a clear responsibility: keep the board trustworthy, the experience responsive, and each player’s games and progress durable.</p>
          </div>
          <div class="about-table-wrap">
            <table class="about-table about-stack-table">
              <thead><tr><th scope="col">Layer</th><th scope="col">Choice</th><th scope="col">Why</th></tr></thead>
              <tbody>
                <tr><td data-label="Layer">Interface</td><td data-label="Choice">Plain browser JavaScript</td><td data-label="Why">Fast delivery, direct platform access, and no generated application layer.</td></tr>
                <tr><td data-label="Layer">Realtime</td><td data-label="Choice">HTTP + SSE</td><td data-label="Why">Simple commands in, authoritative updates out.</td></tr>
                <tr><td data-label="Layer">Game authority</td><td data-label="Choice">One referee per room</td><td data-label="Why">A single order for every state-changing action.</td></tr>
                <tr><td data-label="Layer">Rules</td><td data-label="Choice">Dual validation</td><td data-label="Why">Chess behavior is checked across independent implementations.</td></tr>
                <tr><td data-label="Layer">Engine</td><td data-label="Choice">Stockfish 19 lite</td><td data-label="Why">Strong browser analysis and scalable bot play from the same engine family.</td></tr>
                <tr><td data-label="Layer">Storage</td><td data-label="Choice">SQLite with JSON fallback</td><td data-label="Why">Durability by default, with a portable fallback path.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="about-layers">
            <h3>What each layer is responsible for</h3>
            <ol class="about-layer-list">
              <li><div><strong>Browser experience</strong><p>Shows the latest confirmed board, clocks, and history while keeping play and study tools clear and accessible.</p></div></li>
              <li><div><strong>Connection</strong><p>Keeps player actions and live updates moving reliably between the browser and the authoritative room.</p></div></li>
              <li><div><strong>Game authority</strong><p>Keeps every room consistent by deciding one trustworthy order for state-changing actions.</p></div></li>
              <li><div><strong>Rules assurance</strong><p>Ensures that only legal chess moves can change the position or result.</p></div></li>
              <li><div><strong>Chess services</strong><p>Supports bot opponents, puzzles, analysis, ratings, social play, and study features around each game.</p></div></li>
              <li><div><strong>Durable records</strong><p>Keeps accounts, games, puzzles, ratings, recovery information, and personal progress available over time.</p></div></li>
            </ol>
          </div>
          <p class="about-summary">one referee per room · every mutation serialized · every view re-rendered from truth</p>
        </section>

        <section class="about-section" data-about-section="gallery">
          <div class="about-section-heading">
            <h2>The board, the review, the next problem</h2>
            <p class="about-section-intro">Three views of the same idea: play first, make the evidence readable, then return to the board with a sharper eye.</p>
          </div>
          <div class="about-gallery">
            <figure class="about-figure"><img src="/assets/about/play.png" alt="The chess play view with board and room controls"><figcaption>Play</figcaption></figure>
            <figure class="about-figure"><img src="/assets/about/analysis.png" alt="The analysis view with engine evaluation and move review"><figcaption>Analysis</figcaption></figure>
            <figure class="about-figure"><img src="/assets/about/puzzles.png" alt="The puzzles view for tactical training"><figcaption>Puzzles</figcaption></figure>
          </div>
        </section>

        <section class="about-section" data-about-section="faq">
          <div class="about-section-heading">
            <h2>Is this for me?</h2>
            <p class="about-section-intro">A few direct answers about data, accounts, ratings, connected play, and accessible ways to use the board.</p>
          </div>
          <div class="about-faq-list">
            <details class="about-faq"><summary>Is my data private, and where do games live?</summary><p>Your games stay on this server. The site does not include telemetry, and it does not send gameplay data to an analytics service.</p></details>
            <details class="about-faq"><summary>What works in the browser, and what needs the server?</summary><p>Analysis and game review run entirely in your browser. Live games—including games against built-in bot opponents—need an active connection to the server.</p></details>
            <details class="about-faq"><summary>Do puzzles or analysis need an account?</summary><p>No. You can solve puzzles and use analysis without signing in.</p></details>
            <details class="about-faq"><summary>How do ratings work?</summary><p>Playing ratings use Glicko-2 and are tracked separately for each time control. Puzzle rating is separate, so tactical progress does not change your playing rating.</p></details>
            <details class="about-faq"><summary>Is there a mobile or accessible mode?</summary><p>Yes. Blind mode includes a keyboard-operated 8×8 grid, swipe gestures, spoken moves, voice input, typed SAN or UCI moves, and ARIA live regions. Colour-blind themes are available too.</p></details>
          </div>
        </section>

        <footer class="about-footer-cta" data-about-section="footer">
          <h2 class="about-footer-title">Ready when you are.</h2>
          <div class="about-actions">
            <button class="about-action about-action-primary" type="button" data-about-action="play">Start a game</button>
            <a class="about-action" href="https://chess-game-0zax.onrender.com" target="_blank" rel="noopener">Open live site</a>
          </div>
          <p class="about-footer-note">Local-first · no build step · zero telemetry · Stockfish 19 lite (GPL-3.0)</p>
        </footer>
      </article>
    `;
  }

  function bindEvents() {
    if (!state.el) return;
    state.el.querySelectorAll('[data-about-action="play"]').forEach((button) => {
      button.addEventListener('click', () => {
        if (typeof window !== 'undefined' && window.Shell) window.Shell.navigate('play');
      });
    });
  }

  function mount(el) {
    state.el = el;
    injectStyles();
    renderSkeleton(el);
    bindEvents();
    state.mounted = true;
  }

  function show(el) {
    if (!state.mounted) mount(el);
  }

  function hide() {}

  function init() {
    if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return;
    window.Shell.registerView({
      id: 'about',
      title: 'About',
      order: 90,
      nav: true,
      mount,
      show,
      hide
    });
  }

  const UIAbout = {
    init,
    mount,
    show,
    hide
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UIAbout;
  }
  if (typeof window !== 'undefined') {
    window.UIAbout = UIAbout;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
