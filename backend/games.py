"""
games.py

Little games with real randomness (a model can't be trusted to pick fairly):
rock-paper-scissors (Bit picks before looking at your choice), a coin flip,
a dice roll. Quizzes, 20 questions and "guess the song" need no rules here:
the model hosts them in conversation (see conversation.py's prompt).
"""

import random
import re
import time
from typing import Optional

RPS = ["rock", "paper", "scissors"]
BEATS = {"rock": "scissors", "paper": "rock", "scissors": "paper"}
ALIASES = {"stone": "rock", "scissor": "scissors", "papers": "paper", "rocks": "rock"}

# Running score this session (Bit vs you).
score = {"bit": 0, "you": 0}

rng = random.Random()

# A round of rock-paper-scissors is going (it just asked "rock, paper or
# scissors?" or "again?"): your next short pick is played fairly, without the model.
_expect_rps_until = 0.0
EXPECT_S = 120


def expect_rps(on: bool = True) -> None:
    global _expect_rps_until
    _expect_rps_until = time.time() + EXPECT_S if on else 0.0


def rps_pick(message: str) -> Optional[str]:
    """Your pick, if a round is going and your message is a short reply naming exactly one."""
    if time.time() > _expect_rps_until:
        return None
    words = re.findall(r"[a-z]+", message.lower())
    picks = {ALIASES.get(w, w) for w in words if ALIASES.get(w, w) in RPS}
    return next(iter(picks)) if len(picks) == 1 and len(words) <= 6 else None


def play(name: object, choice: object = None) -> tuple[bool, str, Optional[str]]:
    """-> (ok, what to say, a move to play)"""
    game = str(name or "").strip().lower()
    if game in ("rps", "rock paper scissors", "rock-paper-scissors"):
        mine = rng.choice(RPS)  # chosen before looking at yours
        yours = ALIASES.get(str(choice or "").strip().lower(), str(choice or "").strip().lower())
        if yours not in RPS:
            return False, "Let's play! Rock, paper or scissors?", None
        if mine == yours:
            return True, f"I picked {mine} too! A draw. Again?", "shrug"
        if BEATS[mine] == yours:
            score["bit"] += 1
            return True, f"I picked {mine}, so I win! That's {score['bit']} to {score['you']}. Again?", "dance"
        score["you"] += 1
        return True, f"I picked {mine}. You win! That's {score['you']} to {score['bit']} for you. Again?", "bow"
    if game in ("coin", "flip", "coin flip", "toss"):
        return True, f"It's {rng.choice(['heads', 'tails'])}!", "spin"
    if game in ("dice", "die", "roll"):
        return True, f"You rolled a {rng.randint(1, 6)}!", "hop"
    return False, "I know rock-paper-scissors, coin flips and dice, and I can host a quiz. Which one?", None
