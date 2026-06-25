import { brighten } from "./colors";
import {
  opposite,
  type Dir,
  type PlayerType,
  type KeyMap,
  type AiProfile,
  type Personality,
} from "./types";

export const CHARGE_MAX = 100;

export class Player {
  id: number;
  name: string;
  color: string;
  headColor: string;
  type: PlayerType;
  keys?: KeyMap;

  // AI only: the driving character and the resolved behaviour profile (difficulty
  // baseline transformed by that character). Set in Game.newMatch; null for humans.
  personality?: Personality;
  aiProfile: AiProfile | null = null;

  x = 0;
  y = 0;
  dir: Dir = 1;
  alive = true;
  wins = 0;
  length = 1; // cells laid this round (the trail length)

  // Match totals, accumulated across every round (like wins) and shown on the
  // scoreboard. kills counts rivals destroyed by this cycle's rockets (self-kills
  // don't count); blocksDestroyed counts WALL cells its blasts have cleared.
  kills = 0;
  blocksDestroyed = 0;

  // buffered turns: applied one per step so fast right->down isn't dropped
  inputQueue: Dir[] = [];

  // per-player step timing (independent speeds / sprint)
  baseInterval: number;
  acc = 0;
  sprint = false;

  // AI only: steps left to commit to driving straight after blasting an escape
  // hole, so the bot actually punches through the wall instead of curling back
  // along it and re-trapping. Counts down each AI step.
  escapeSteps = 0;

  // Set the step a rocket is fired (see Game.tryShoot), read+cleared by aiSprint:
  // a cycle must NOT sprint the frame it shoots. Sprinting advances two cells and
  // lays trail in the cell its freshly-launched rocket needs to traverse, so the
  // rocket detonates point-blank on that own trail and kills the firer. Moving a
  // single cell keeps the rocket on the firer's (collision-exempt) head until it
  // outruns the cycle and flies clear.
  firedThisStep = false;

  // AI only: steps left before the bot re-runs its full (expensive) steering
  // scan. Between full scans it coasts on its last heading as long as the cell
  // ahead stays clear — a bot moves one cell per step, so a plan stays good for
  // a few steps. Spread across bots so they don't all replan on the same tick.
  // See Game.aiThink / AI_THINK_PERIOD.
  aiCooldown = 0;

  // weapon charge (0..CHARGE_MAX)
  charge = CHARGE_MAX;

  constructor(
    id: number,
    name: string,
    color: string,
    type: PlayerType,
    baseInterval: number,
    keys?: KeyMap,
  ) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.headColor = brighten(color, 0.55);
    this.type = type;
    this.baseInterval = baseInterval;
    this.keys = keys;
  }

  get interval(): number {
    return this.sprint ? this.baseInterval * 0.5 : this.baseInterval;
  }

  get charged(): boolean {
    return this.charge >= CHARGE_MAX;
  }

  spawn(x: number, y: number, dir: Dir): void {
    this.x = x;
    this.y = y;
    this.dir = dir;
    this.inputQueue.length = 0;
    this.alive = true;
    this.acc = 0;
    this.sprint = false;
    this.escapeSteps = 0;
    this.firedThisStep = false;
    this.aiCooldown = 0;
    this.charge = CHARGE_MAX;
    this.length = 1;
  }

  // the heading the next queued turn is measured against: the tail of the
  // buffer if turns are pending, otherwise the live heading. Relative
  // (turn-left / turn-right) controls steer against this so rapid taps chain
  // correctly instead of being rejected as duplicates of the live heading.
  get pendingDir(): Dir {
    return this.inputQueue.length > 0
      ? this.inputQueue[this.inputQueue.length - 1]
      : this.dir;
  }

  // queue a turn, validated against the last intended direction so we never
  // queue a reversal or a duplicate
  queueTurn(dir: Dir): void {
    const ref = this.pendingDir;
    if (dir === ref || dir === opposite(ref)) return;
    if (this.inputQueue.length < 3) this.inputQueue.push(dir);
  }

  // pull the next buffered turn into the live heading (called once per step)
  applyNextTurn(): void {
    if (this.inputQueue.length > 0) {
      this.dir = this.inputQueue.shift()!;
    }
  }
}
