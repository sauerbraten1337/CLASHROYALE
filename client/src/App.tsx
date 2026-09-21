/**
 * Application shell.
 *
 * Owns the screen router, the persisted profile, and the single server
 * connection. Match sessions are created here and handed to the battle
 * screen as a factory, so all the online/offline branching stays in one
 * place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BotDifficulty,
  ServerMessageType,
  Team,
  type MatchResult,
  type MatchRewards,
  type ServerMessage,
} from '@riftbound/shared';

import { Connection, loadPlayerId, type ConnectionStatus } from './net/Connection.js';
import {
  LocalSession,
  OnlineSession,
  type MatchSession,
  type MatchSessionEvents,
} from './net/session.js';
import { Battle } from './screens/Battle.jsx';
import { DeckBuilder } from './screens/DeckBuilder.jsx';
import {
  BotSetup,
  Collection,
  MainMenu,
  Matchmaking,
  PrivateRoom,
  ProfileScreen,
  ResultScreen,
  SettingsScreen,
} from './screens/Menus.jsx';
import { audio } from './game/audio.js';
import {
  activeDeck,
  applyRewards,
  defaultProfile,
  loadProfile,
  saveProfile,
  type Profile,
  type SavedDeck,
  type Settings,
} from './state/profile.js';

type Screen =
  | 'menu'
  | 'bot-setup'
  | 'matchmaking'
  | 'private'
  | 'battle'
  | 'result'
  | 'deck'
  | 'collection'
  | 'profile'
  | 'settings';

/**
 * Everything needed to build the session for the pending match.
 *
 * `instanceId` is assigned once, when the match is queued up, and is what
 * keys the battle screen. It must not be derived at render time or the
 * screen would remount on every render.
 */
type PendingMatch =
  | { kind: 'local'; difficulty: BotDifficulty; instanceId: string }
  | { kind: 'online'; matchId: string; team: Team; opponentName: string; instanceId: string };

interface FinishedMatch {
  result: MatchResult;
  rewards: MatchRewards;
  team: Team;
  levelsGained: number;
  newCards: string[];
}

export function App(): JSX.Element {
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [screen, setScreen] = useState<Screen>('menu');
  const [pending, setPending] = useState<PendingMatch | null>(null);
  const [finished, setFinished] = useState<FinishedMatch | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [queued, setQueued] = useState(0);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);

  // One connection for the whole app lifetime.
  const connectionRef = useRef<Connection | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // --- Persistence --------------------------------------------------------

  useEffect(() => {
    saveProfile(profile);
  }, [profile]);

  // --- Audio settings -----------------------------------------------------

  useEffect(() => {
    audio.setMuted(profile.settings.muted);
    audio.setSfxVolume(profile.settings.sfxVolume);
    audio.setMusicVolume(profile.settings.musicVolume);
  }, [profile.settings.muted, profile.settings.sfxVolume, profile.settings.musicVolume]);

  // --- Connection ---------------------------------------------------------

  useEffect(() => {
    const connection = new Connection();
    connectionRef.current = connection;

    const offStatus = connection.onStatus((status) => setConnectionStatus(status));

    const offMessage = connection.subscribe((message: ServerMessage) => {
      switch (message.type) {
        case ServerMessageType.QueueStatus:
          setQueued(message.queued);
          break;

        case ServerMessageType.MatchFound:
          // Move straight into the arena; the battle screen builds the session.
          setRoomCode(null);
          setRoomError(null);
          setPending({
            kind: 'online',
            matchId: message.matchId,
            team: message.team,
            opponentName: message.opponentName,
            instanceId: `online-${message.matchId}`,
          });
          setScreen('battle');
          break;

        case ServerMessageType.PrivateRoom:
          setRoomCode(message.code);
          setRoomError(null);
          break;

        case ServerMessageType.Error:
          // Room errors belong on the private-match screen; play rejections
          // are handled inside the battle session instead.
          if (message.code === 'no-such-room' || message.code === 'own-room') {
            setRoomError(message.message);
          }
          break;

        default:
          break;
      }
    });

    connection.connect(profileRef.current.name, loadPlayerId());

    return () => {
      offStatus();
      offMessage();
      connection.close();
      connectionRef.current = null;
    };
    // Deliberately runs once: the connection outlives every screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Navigation helpers -------------------------------------------------

  const goMenu = useCallback(() => {
    connectionRef.current?.leaveQueue();
    connectionRef.current?.leavePrivate();
    setRoomCode(null);
    setRoomError(null);
    setPending(null);
    setScreen('menu');
  }, []);

  const startOnline = useCallback(() => {
    audio.unlock();
    const connection = connectionRef.current;
    if (!connection || !connection.isConnected) {
      // No server: offer practice rather than a dead end.
      setScreen('bot-setup');
      return;
    }
    connection.joinQueue(activeDeck(profileRef.current), profileRef.current.trophies);
    setScreen('matchmaking');
  }, []);

  const startBot = useCallback((difficulty: BotDifficulty) => {
    audio.unlock();
    setPending({ kind: 'local', difficulty, instanceId: `local-${Date.now().toString(36)}` });
    setScreen('battle');
  }, []);

  /**
   * Builds the session for the pending match. Passed to the battle screen,
   * which calls it once when it mounts.
   */
  const createSession = useCallback(
    (events: MatchSessionEvents): MatchSession => {
      const match = pending;
      const connection = connectionRef.current;

      if (match?.kind === 'online' && connection) {
        return new OnlineSession(
          connection,
          { matchId: match.matchId, team: match.team, opponentName: match.opponentName },
          events,
        );
      }

      return new LocalSession(
        {
          playerName: profileRef.current.name,
          deck: activeDeck(profileRef.current),
          difficulty: match?.kind === 'local' ? match.difficulty : BotDifficulty.Normal,
        },
        events,
      );
    },
    [pending],
  );

  const onMatchFinished = useCallback((result: MatchResult, rewards: MatchRewards) => {
    // The local player's team comes from the match they are in, never from
    // the result: on a draw there is no winner to infer it from.
    const team = pendingTeam(pendingRef.current) ?? Team.Blue;
    const outcome = result.winner === null ? 'draw' : result.winner === team ? 'win' : 'loss';
    const progression = applyRewards(profileRef.current, rewards, outcome);

    setProfile(progression.profile);
    setFinished({
      result,
      rewards,
      team,
      levelsGained: progression.levelsGained,
      newCards: progression.newCards,
    });
    setScreen('result');
  }, []);

  // The finish handler needs the pending match without re-creating itself.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const rematch = useCallback(() => {
    const previous = pendingRef.current;
    setFinished(null);
    if (previous?.kind === 'local') {
      setPending({
        kind: 'local',
        difficulty: previous.difficulty,
        instanceId: `local-${Date.now().toString(36)}`,
      });
      setScreen('battle');
    } else {
      startOnline();
    }
  }, [startOnline]);

  // --- Profile mutations --------------------------------------------------

  const saveDecks = useCallback((decks: SavedDeck[], activeDeckId: string) => {
    setProfile((current) => ({ ...current, decks, activeDeckId }));
    setScreen('menu');
  }, []);

  const updateSettings = useCallback((settings: Settings) => {
    setProfile((current) => ({ ...current, settings }));
  }, []);

  const rename = useCallback((name: string) => {
    setProfile((current) => ({ ...current, name }));
    // Re-identify so the opponent sees the new name.
    connectionRef.current?.connect(name, loadPlayerId());
  }, []);

  const resetProgress = useCallback(() => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Reset all progress? This cannot be undone.')) return;
    const fresh = defaultProfile();
    setProfile(fresh);
    saveProfile(fresh);
    setScreen('menu');
  }, []);

  // --- Render -------------------------------------------------------------

  const settings = useMemo(() => profile.settings, [profile.settings]);

  switch (screen) {
    case 'battle':
      return (
        <div className="app">
          <Battle
            // A fresh key per match guarantees a clean render loop and a new
            // session rather than a reused one. The id is fixed when the match
            // is queued, never derived during render.
            key={pending?.instanceId ?? 'no-match'}
            createSession={createSession}
            settings={settings}
            onFinished={onMatchFinished}
            onQuit={goMenu}
          />
        </div>
      );

    case 'result':
      return (
        <div className="app">
          {finished && (
            <ResultScreen
              result={finished.result}
              rewards={finished.rewards}
              team={finished.team}
              levelsGained={finished.levelsGained}
              newCards={finished.newCards}
              onContinue={goMenu}
              onRematch={rematch}
            />
          )}
        </div>
      );

    case 'bot-setup':
      return (
        <div className="app">
          <BotSetup profile={profile} onStart={startBot} onBack={goMenu} />
        </div>
      );

    case 'matchmaking':
      return (
        <div className="app">
          <Matchmaking status={connectionStatus} queued={queued} onCancel={goMenu} />
        </div>
      );

    case 'private':
      return (
        <div className="app">
          <PrivateRoom
            code={roomCode}
            status={connectionStatus}
            error={roomError}
            onCreate={() => connectionRef.current?.createPrivate(activeDeck(profile))}
            onJoin={(code) => connectionRef.current?.joinPrivate(code, activeDeck(profile))}
            onBack={goMenu}
          />
        </div>
      );

    case 'deck':
      return (
        <div className="app">
          <DeckBuilder profile={profile} onSave={saveDecks} onBack={goMenu} />
        </div>
      );

    case 'collection':
      return (
        <div className="app">
          <Collection profile={profile} onBack={goMenu} />
        </div>
      );

    case 'profile':
      return (
        <div className="app">
          <ProfileScreen profile={profile} onBack={goMenu} onRename={rename} />
        </div>
      );

    case 'settings':
      return (
        <div className="app">
          <SettingsScreen
            settings={settings}
            onChange={updateSettings}
            onBack={goMenu}
            onReset={resetProgress}
          />
        </div>
      );

    default:
      return (
        <div className="app">
          <MainMenu
            profile={profile}
            connectionStatus={connectionStatus}
            onPlayOnline={startOnline}
            onPlayBot={() => setScreen('bot-setup')}
            onPrivate={() => setScreen('private')}
            onDeck={() => setScreen('deck')}
            onCollection={() => setScreen('collection')}
            onProfile={() => setScreen('profile')}
            onSettings={() => setScreen('settings')}
          />
        </div>
      );
  }
}

/** The local player's team for the pending match. */
function pendingTeam(pending: PendingMatch | null): Team | null {
  if (!pending) return null;
  return pending.kind === 'online' ? pending.team : Team.Blue;
}
