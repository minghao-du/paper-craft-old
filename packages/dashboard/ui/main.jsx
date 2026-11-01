import { I18nProvider, useI18n } from './i18n.jsx';
import { readFailure } from './i18n-core.js';
import RecentChanges from './RecentChanges.jsx';
import { TaskLogs } from './TaskLogs.jsx';
import RemoteEvidence from './RemoteEvidence.jsx';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { GitHubEvidence } from './GitHubEvidence.jsx';
import GitEvidence from './GitEvidence.jsx';

const access = new URLSearchParams(location.hash.slice(1)).get('token');
if (access) {
  sessionStorage.setItem('dashboard-token', access);
  history.replaceState(null, '', location.pathname);
}
export async function read(path) {
  const result = await fetch(path, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem('dashboard-token') || ''}` },
  });
  if (!result.ok) throw readFailure(result.status);
  return result.json();
}
function App() {
  const { language, setLanguage, t, formatDate, errorText } = useI18n();
  const [snapshot, setSnapshot] = useState(null),
    [error, setError] = useState(''),
    [fleetId, setFleetId] = useState(''),
    [query, setQuery] = useState(''),
    [phase, setPhase] = useState(''),
    [attention, setAttention] = useState(false);
  const waitingLabels = {
    planned: t('main.planned'),
    overdue: t('main.overdue'),
    unknown: t('main.unknown'),
  };
  const load = () =>
    read('/api/snapshot')
      .then(setSnapshot)
      .catch((e) => setError(e));
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <main>
      <div className="brand-bar">
        <a href="/" className="brand">
          <span className="brand-icon">
            p<span>c</span>
          </span>
          paper-craft <span className="brand-divider">/</span>{' '}
          <span className="brand-product">Fleet</span>
        </a>
        <span className="observation-mode">{t('main.readOnly')}</span>
      </div>
      <header>
        <div>
          <div className="eyebrow">WORKSPACE OVERVIEW</div>
          <h1>{t('main.title')}</h1>
          <p>{t('main.warning')}</p>
        </div>
        <div className="header-controls">
          <div role="group" aria-label={t('main.language')}>
            <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>
              English
            </button>
            <button aria-pressed={language === 'zh-CN'} onClick={() => setLanguage('zh-CN')}>
              简体中文
            </button>
          </div>
          <button
            onClick={() =>
              read('/api/refresh')
                .then(setSnapshot)
                .catch((e) => setError(e))
            }
          >
            {t('main.refresh')}
          </button>
        </div>
      </header>
      {error && <p role="alert">{errorText(error)}</p>}
      {snapshot && (
        <>
          <div className="overview-grid">
            <div className="metric">
              <span>{t('main.fleetsCount')}</span>
              <strong>{snapshot.fleets.length.toString().padStart(2, '0')}</strong>
              <small>{t('main.configured')}</small>
            </div>
            <div className="metric">
              <span>{t('main.tasksCount')}</span>
              <strong>
                {snapshot.fleets
                  .flatMap((f) => f.tasks)
                  .length.toString()
                  .padStart(2, '0')}
              </strong>
              <small>{t('main.recorded')}</small>
            </div>
            <div className="metric metric-attention">
              <span>{t('main.attention')}</span>
              <strong>
                {snapshot.fleets
                  .flatMap((f) => f.tasks)
                  .filter((t) => t.interventions?.length)
                  .length.toString()
                  .padStart(2, '0')}
              </strong>
              <small>{t('main.guidance')}</small>
            </div>
          </div>
          <nav>
            <label>
              {t('main.fleet')}{' '}
              <select value={fleetId} onChange={(e) => setFleetId(e.target.value)}>
                <option value="">{t('main.allFleets')}</option>
                {snapshot.fleets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.config}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              {t('main.search')} <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>{' '}
            <label>
              {t('main.phase')} <input value={phase} onChange={(e) => setPhase(e.target.value)} />
            </label>{' '}
            <label>
              <input
                type="checkbox"
                checked={attention}
                onChange={(e) => setAttention(e.target.checked)}
              />
              {t('main.attention')}
            </label>
          </nav>
          <p className="snapshot-meta">
            {t('main.observedVersion', {
              time: formatDate(snapshot.generatedAt),
              version: snapshot.version,
            })}
          </p>
          {snapshot.fleets
            .filter((f) => !fleetId || f.id === fleetId)
            .map((fleet) => (
              <section className="fleet-section" key={fleet.id}>
                <div className="eyebrow">FLEET / {fleet.id.slice(0, 8)}</div>
                <h2 title={fleet.config}>
                  {fleet.config.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || fleet.config}
                </h2>
                <small className="config-path">{fleet.config}</small>
                <p>
                  {t('main.project', {
                    id: fleet.id,
                    project: fleet.project || t('main.unassociated'),
                  })}
                </p>
                {fleet.error && (
                  <p role="alert">
                    {fleet.error} {fleet.stale && t('main.stale')}
                  </p>
                )}
                <GitEvidence fleetId={fleet.id} />
                <RemoteEvidence fleetId={fleet.id} />
                <div className="task-table">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('main.association')}</th>
                        <th>{t('main.phase')}</th>
                        <th>{t('main.summary')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fleet.tasks
                        .filter(
                          (t) =>
                            (!phase || t.phase.includes(phase)) &&
                            (!attention || t.interventions?.length) &&
                            [
                              fleet.config,
                              fleet.project,
                              t.slot,
                              t.summary,
                              t.phase,
                              t.issue,
                              ...t.blockers,
                            ]
                              .join(' ')
                              .toLowerCase()
                              .includes(query.toLowerCase()),
                        )
                        .map((task) => (
                          <tr key={task.id}>
                            <td>
                              <strong className="task-name">{task.slot}</strong>
                              <small>{task.role}</small>
                            </td>
                            <td>
                              <span className="phase-badge" data-phase={task.phase}>
                                {task.phase}
                              </span>
                            </td>
                            <td>
                              {task.summary}
                              <details>
                                <summary>
                                  {t('main.evidence')} {task.stale ? t('main.stale') : ''}
                                </summary>
                                <GitHubEvidence taskId={task.id} />
                                <p>{t('main.source', { source: task.source })}</p>
                                <p>{t('main.observed', { time: formatDate(task.observedAt) })}</p>
                                <p>
                                  {t('main.runtime', {
                                    runtime:
                                      task.runtime === 'unknown' ? t('main.unknown') : task.runtime,
                                    identity:
                                      task.executionIdentity === 'unknown'
                                        ? t('main.unknown')
                                        : task.executionIdentity,
                                  })}
                                </p>
                                {task.error && <p role="alert">{task.error}</p>}
                                <p>
                                  {t('main.waiting', {
                                    waiting: task.waiting
                                      ? Object.hasOwn(waitingLabels, task.waiting)
                                        ? waitingLabels[task.waiting]
                                        : task.waiting
                                      : t('main.notRecorded'),
                                    time: task.modifiedAt
                                      ? formatDate(task.modifiedAt)
                                      : t('main.unknown'),
                                  })}
                                </p>
                                <ul>
                                  {task.interventions?.map((item, i) => (
                                    <li key={i}>
                                      {item.reason}
                                      <small>{t('main.source', { source: item.source })}</small>
                                    </li>
                                  ))}
                                </ul>
                                <details>
                                  <summary>{t('main.runtimeObservations')}</summary>
                                  <pre>{JSON.stringify(task.runtimeEvidence, null, 2)}</pre>
                                </details>
                                {task.executionEvidence && (
                                  <details>
                                    <summary>{t('main.executionEvidence')}</summary>
                                    <div className="execution-evidence">
                                      <p>
                                        <strong>
                                          {t('main.executionAcceptance', {
                                            acceptance:
                                              task.executionEvidence.acceptance ||
                                              t('main.unknown'),
                                          })}
                                        </strong>
                                      </p>
                                      {task.executionEvidence.attempts?.map((attempt) => (
                                        <section
                                          key={attempt.id}
                                          className="execution-attempt-card"
                                        >
                                          <strong>
                                            {t('main.executionAttempt', { id: attempt.id })}
                                            {attempt.stale && ` ${t('main.stale')}`}
                                          </strong>
                                          <div className="execution-field-grid">
                                            <p>{t('main.executionRole', { role: attempt.role })}</p>
                                            <p>
                                              {t('main.executionRunner', {
                                                runner: attempt.runner,
                                              })}
                                            </p>
                                            <p>
                                              {t('main.executionAddress', {
                                                address: attempt.address || t('main.noneRecorded'),
                                              })}
                                            </p>
                                            <p>
                                              {t('main.executionStatus', {
                                                status:
                                                  attempt.execution ||
                                                  attempt.recordedStatus ||
                                                  t('main.unknown'),
                                              })}
                                            </p>
                                            <p>
                                              {t('main.executionObserved', {
                                                time: attempt.observation?.at
                                                  ? formatDate(attempt.observation.at)
                                                  : t('main.unknown'),
                                              })}
                                            </p>
                                          </div>
                                          {attempt.observation?.evidence && (
                                            <p>
                                              <small>{attempt.observation.evidence}</small>
                                            </p>
                                          )}
                                          {attempt.error && <p role="alert">{attempt.error}</p>}
                                        </section>
                                      ))}
                                      <details>
                                        <summary>{t('main.executionRaw')}</summary>
                                        <pre>{JSON.stringify(task.executionEvidence, null, 2)}</pre>
                                      </details>
                                    </div>
                                  </details>
                                )}
                                <TaskLogs task={task} read={read} />
                                <p>
                                  {t('main.blockers', {
                                    blockers: task.blockers.join(', ') || t('main.noneRecorded'),
                                  })}
                                </p>
                              </details>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
        </>
      )}
      <RecentChanges read={read} fleetId={fleetId} />
    </main>
  );
}
createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
