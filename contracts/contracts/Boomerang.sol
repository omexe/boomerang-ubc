// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// The three token calls Boomerang makes.
interface IToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Boomerang: a crowdfund where backing early is safe.
///
/// A sponsor locks two pots before a campaign opens: a match, paid to the recipient only if the
/// target is met, and a bonus, paid to early backers only if it is missed. Target met: the recipient
/// gets the pledges plus the match. Target missed: every backer gets everything back and early
/// backers split the bonus, weighted by how early and how much.
///
/// One contract holds every campaign. It has no owner, no upgrade path, no pause and no sweep.
/// Terms are fixed when a campaign is created. Paying out is open to anyone and can only pay the
/// recorded destination.
contract Boomerang {
    // ---------------------------------------------------------------- types

    struct Terms {
        address recipient;
        uint64 opensAt; // pledging opens; both pots must be in before this second
        uint64 earlyUntil; // weight is zero from this second
        uint64 closesAt; // pledges are refused from this second
        uint128 target;
        uint128 minPledge;
        uint128 matchAmount; // paid to the recipient only if the target is met
        uint128 bonusPool; // paid to early backers only if the target is missed
        uint16 rateBps; // bonus rate in basis points, at most 10_000
        bool linearWeight; // false: flat weight through the early window
        bool bonusFromRecipient; // who must fund the bonus pot: the recipient, else the sponsor
    }

    enum Outcome {
        Open,
        Funded,
        Missed,
        Void
    }

    enum Side {
        Recipient, // pledges plus match, when funded
        MatchReturn, // the match back to the sponsor, when missed or void
        BonusReturn // the unpaid bonus back to its funder
    }

    struct State {
        address sponsor;
        Outcome outcome;
        bool matchIn;
        bool bonusIn;
        bool recipientPaid;
        bool matchReturned;
        bool bonusReturned;
        uint32 backers;
        uint128 pledged; // counted pledges, and a rescue
        uint128 pledgedEarly; // counted before earlyUntil
        uint128 weighted; // sum of amount x weight over early pledges
        uint128 bonusPaid; // the bonus early backers split; set when the campaign is missed
    }

    struct Backer {
        uint128 principal;
        uint128 weighted;
        address payTo; // zero: pay the backer's own address
        bool paid;
    }

    // ------------------------------------------------------------ constants

    uint256 public constant WEIGHT_ONE = 1_000_000;
    uint256 public constant MAX_AMOUNT = 1e15; // 10^9 USDC at 6 decimals
    uint256 public constant MAX_RATE_BPS = 10_000;
    uint256 private constant RATE_DIVISOR = 1e10; // basis points x weight scale

    // -------------------------------------------------------------- storage

    IToken public immutable usdc;

    uint256 public campaignCount;
    /// Everything taken in and not yet paid out. The contract's balance is never below it.
    /// Rounding dust from bonus shares stays counted here and is never paid to anyone.
    uint256 public totalOwed;
    /// Number of events emitted so far. Every event carries its number, from 1, with no gaps.
    uint256 public eventCount;

    mapping(uint256 id => Terms) private _terms;
    mapping(uint256 id => State) private _state;
    mapping(uint256 id => mapping(address backer => Backer)) private _backers;
    bool private _entered;

    // --------------------------------------------------------------- events

    event CampaignCreated(uint256 indexed seq, uint256 indexed id, address indexed sponsor, Terms terms);
    event PotFunded(uint256 indexed seq, uint256 indexed id, bool bonus, address from, uint256 amount);
    event Pledged(
        uint256 indexed seq, uint256 indexed id, address indexed backer, address payer, uint256 amount, uint256 weight
    );
    event Rescued(uint256 indexed seq, uint256 indexed id, uint256 amount);
    event Finalized(uint256 indexed seq, uint256 indexed id, Outcome outcome, uint256 bonusPaid);
    event Paid(
        uint256 indexed seq, uint256 indexed id, address indexed backer, address to, uint256 principal, uint256 bonus
    );
    event PayFailed(uint256 indexed seq, uint256 indexed id, address indexed backer, address to, uint256 amount);
    event SidePaid(uint256 indexed seq, uint256 indexed id, Side side, address to, uint256 amount);
    event Redirected(uint256 indexed seq, uint256 indexed id, address indexed backer, address to);

    // --------------------------------------------------------------- errors

    error BadTerms(string what);
    error NoSuchCampaign();
    error NotSponsor();
    error NotFunder();
    error TooLate();
    error AlreadyFunded();
    error NothingToFund();
    error NotOpenYet();
    error Closed();
    error CampaignVoid();
    error OutcomeSet();
    error SponsorCannotPledge();
    error ZeroAddress();
    error ZeroAmount();
    error BelowMinimum();
    error NotDue();
    error NotFinal();
    error NoRecord();
    error AlreadyPaid();
    error TransferFailed();
    error Reentered();

    modifier guarded() {
        if (_entered) revert Reentered();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address token) {
        if (token == address(0)) revert ZeroAddress();
        usdc = IToken(token);
    }

    // ------------------------------------------------------------- sponsors

    /// Create a campaign. The caller is its sponsor. Ids start at 1.
    function createCampaign(Terms calldata t) external guarded returns (uint256 id) {
        if (t.recipient == address(0) || t.recipient == address(this)) revert BadTerms("recipient");
        if (!(block.timestamp < t.opensAt && t.opensAt < t.earlyUntil && t.earlyUntil < t.closesAt)) {
            revert BadTerms("times");
        }
        if (t.target == 0 || t.target > MAX_AMOUNT) revert BadTerms("target");
        if (t.minPledge == 0 || t.minPledge > t.target) revert BadTerms("minPledge");
        if (t.matchAmount > MAX_AMOUNT) revert BadTerms("matchAmount");
        if (t.bonusPool > MAX_AMOUNT) revert BadTerms("bonusPool");
        if (t.rateBps > MAX_RATE_BPS) revert BadTerms("rateBps");

        id = ++campaignCount;
        _terms[id] = t;
        _state[id].sponsor = msg.sender;
        emit CampaignCreated(_next(), id, msg.sender, t);
    }

    /// The sponsor puts in the whole match, once, before the campaign opens.
    function fundMatch(uint256 id) external guarded {
        (Terms storage t, State storage s) = _load(id);
        if (msg.sender != s.sponsor) revert NotSponsor();
        if (block.timestamp >= t.opensAt) revert TooLate();
        if (s.matchIn) revert AlreadyFunded();
        if (t.matchAmount == 0) revert NothingToFund();
        s.matchIn = true;
        _takeIn(msg.sender, t.matchAmount);
        emit PotFunded(_next(), id, false, msg.sender, t.matchAmount);
    }

    /// The named funder (the recipient or the sponsor) puts in the whole bonus pot, once,
    /// before the campaign opens.
    function fundBonus(uint256 id) external guarded {
        (Terms storage t, State storage s) = _load(id);
        if (msg.sender != _bonusFunder(t, s)) revert NotFunder();
        if (block.timestamp >= t.opensAt) revert TooLate();
        if (s.bonusIn) revert AlreadyFunded();
        if (t.bonusPool == 0) revert NothingToFund();
        s.bonusIn = true;
        _takeIn(msg.sender, t.bonusPool);
        emit PotFunded(_next(), id, true, msg.sender, t.bonusPool);
    }

    /// The sponsor closes the whole remaining gap with new money. The campaign is funded at once
    /// and the money goes to the recipient. It earns no weight and is never refunded.
    function rescue(uint256 id) external guarded returns (uint256 taken) {
        (Terms storage t, State storage s) = _load(id);
        if (msg.sender != s.sponsor) revert NotSponsor();
        _requirePledgeable(t, s);
        taken = t.target - s.pledged;
        s.pledged = t.target;
        s.outcome = Outcome.Funded;
        _takeIn(msg.sender, taken);
        emit Rescued(_next(), id, taken);
        emit Finalized(_next(), id, Outcome.Funded, 0);
    }

    // -------------------------------------------------------------- backers

    /// Pledge for yourself. Only what counts is taken: at most the remaining gap.
    function pledge(uint256 id, uint256 amount) external guarded returns (uint256 taken) {
        return _pledge(id, msg.sender, msg.sender, amount);
    }

    /// Pledge for someone else: the caller pays, the backer owns the record and any payout.
    function pledgeFor(uint256 id, address backer, uint256 amount) external guarded returns (uint256 taken) {
        return _pledge(id, msg.sender, backer, amount);
    }

    /// A backer changes where their own payout goes.
    function redirect(uint256 id, address to) external guarded {
        _load(id);
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        Backer storage b = _backers[id][msg.sender];
        if (b.principal == 0) revert NoRecord();
        if (b.paid) revert AlreadyPaid();
        b.payTo = to;
        emit Redirected(_next(), id, msg.sender, to);
    }

    // --------------------------------------------------------------- anyone

    /// Set the outcome once it is due: missed from the closing second, void from the opening
    /// second when a pot is missing. A funded campaign needs no call. Calling again does nothing.
    function finalize(uint256 id) external guarded {
        (Terms storage t, State storage s) = _load(id);
        if (s.outcome != Outcome.Open) return;
        Outcome o = _outcomeNow(t, s);
        if (o == Outcome.Open) revert NotDue();
        s.outcome = o;
        uint256 bonus;
        if (o == Outcome.Missed) {
            bonus = _bonusFor(t, s.pledgedEarly, s.weighted);
            s.bonusPaid = uint128(bonus);
        }
        emit Finalized(_next(), id, o, bonus);
    }

    /// Pay one backer of a missed campaign: the pledge back, plus the bonus share.
    /// Returns 0 when nothing is owed. Reverts if the transfer fails.
    function pay(uint256 id, address backer) external guarded returns (uint256 paid) {
        (, State storage s) = _load(id);
        bool ok;
        (paid, ok) = _payBacker(id, s, backer);
        if (!ok) revert TransferFailed();
    }

    /// Pay many backers. A payout that fails is skipped and stays owed.
    function payMany(uint256 id, address[] calldata backers) external guarded returns (uint256 paidCount) {
        (, State storage s) = _load(id);
        for (uint256 i = 0; i < backers.length; ++i) {
            (uint256 paid, bool ok) = _payBacker(id, s, backers[i]);
            if (ok && paid != 0) ++paidCount;
        }
    }

    /// Pay the recipient, or return a pot to its funder. Returns 0 when nothing is owed.
    /// Reverts if the transfer fails.
    function paySide(uint256 id, Side side) external guarded returns (uint256 paid) {
        (Terms storage t, State storage s) = _load(id);
        if (s.outcome == Outcome.Open) revert NotFinal();
        paid = _sideAmount(t, s, side);
        if (paid == 0) return 0;
        address to;
        if (side == Side.Recipient) {
            if (s.recipientPaid) return 0;
            s.recipientPaid = true;
            to = t.recipient;
        } else if (side == Side.MatchReturn) {
            if (s.matchReturned) return 0;
            s.matchReturned = true;
            to = s.sponsor;
        } else {
            if (s.bonusReturned) return 0;
            s.bonusReturned = true;
            to = _bonusFunder(t, s);
        }
        totalOwed -= paid;
        if (!_send(to, paid)) revert TransferFailed();
        emit SidePaid(_next(), id, side, to, paid);
    }

    // ---------------------------------------------------------------- views

    function termsOf(uint256 id) external view returns (Terms memory) {
        _exists(id);
        return _terms[id];
    }

    function stateOf(uint256 id) external view returns (State memory) {
        _exists(id);
        return _state[id];
    }

    function backerOf(uint256 id, address backer) external view returns (Backer memory) {
        _exists(id);
        return _backers[id][backer];
    }

    /// The outcome `finalize` would record now.
    function outcomeNow(uint256 id) external view returns (Outcome) {
        _exists(id);
        return _outcomeNow(_terms[id], _state[id]);
    }

    /// Weight of a pledge arriving at `time`, from 0 to WEIGHT_ONE.
    function weightAt(uint256 id, uint64 time) external view returns (uint256) {
        _exists(id);
        return _weightAt(_terms[id], time);
    }

    /// What a new backer pledging `amount` now would be owed if the campaign then missed with no
    /// further pledges: `counted` back, plus `bonus` for this pledge alone. `wouldFund` means the
    /// pledge would meet the target instead. Returns (false, 0, 0) when such a pledge would be
    /// refused for its size or timing. It does not know who is asking: the sponsor's own account
    /// can never pledge, and a backer who already pledged should read `positionIfMissed` after.
    function quoteIfMissed(uint256 id, uint256 amount)
        external
        view
        returns (bool wouldFund, uint256 counted, uint256 bonus)
    {
        _exists(id);
        Terms storage t = _terms[id];
        State storage s = _state[id];
        if (amount == 0 || _outcomeNow(t, s) != Outcome.Open) return (false, 0, 0);
        if (block.timestamp < t.opensAt || block.timestamp >= t.closesAt) return (false, 0, 0);
        uint256 gap = t.target - s.pledged;
        if (amount >= gap) return (true, gap, 0);
        if (amount < t.minPledge) return (false, 0, 0);
        counted = amount;
        uint256 weight = _weightAt(t, uint64(block.timestamp));
        if (weight == 0) return (false, counted, 0);
        uint256 mine = amount * weight;
        uint256 weighted = s.weighted + mine;
        uint256 pool = _bonusFor(t, s.pledgedEarly + amount, weighted);
        bonus = pool * mine / weighted;
    }

    /// What a backer is owed now. Zero unless the campaign is missed and the backer is unpaid.
    function owedTo(uint256 id, address backer) external view returns (uint256 principal, uint256 bonus) {
        _exists(id);
        State storage s = _state[id];
        Backer storage b = _backers[id][backer];
        if (s.outcome != Outcome.Missed || b.paid) return (0, 0);
        return (b.principal, _share(s.bonusPaid, b.weighted, s.weighted));
    }

    /// What a backer would be owed if the campaign missed with the totals as they stand.
    /// Zero once the backer is paid, and zero for a campaign that was funded or is void.
    function positionIfMissed(uint256 id, address backer) external view returns (uint256 principal, uint256 bonus) {
        _exists(id);
        Terms storage t = _terms[id];
        State storage s = _state[id];
        Backer storage b = _backers[id][backer];
        if (b.paid || s.outcome == Outcome.Funded || s.outcome == Outcome.Void) return (0, 0);
        uint256 pool = s.outcome == Outcome.Missed ? s.bonusPaid : _bonusFor(t, s.pledgedEarly, s.weighted);
        return (b.principal, _share(pool, b.weighted, s.weighted));
    }

    // ------------------------------------------------------------- internal

    function _pledge(uint256 id, address payer, address backer, uint256 amount) private returns (uint256 taken) {
        (Terms storage t, State storage s) = _load(id);
        if (backer == address(0) || backer == address(this)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (payer == s.sponsor || backer == s.sponsor) revert SponsorCannotPledge();
        _requirePledgeable(t, s);

        uint256 gap = t.target - s.pledged;
        if (amount >= gap) {
            taken = gap;
        } else {
            if (amount < t.minPledge) revert BelowMinimum();
            taken = amount;
        }

        uint256 weight = _weightAt(t, uint64(block.timestamp));
        Backer storage b = _backers[id][backer];
        if (b.principal == 0) ++s.backers;
        b.principal += uint128(taken);
        if (block.timestamp < t.earlyUntil) {
            s.pledgedEarly += uint128(taken);
            if (weight != 0) {
                uint128 w = uint128(taken * weight);
                b.weighted += w;
                s.weighted += w;
            }
        }
        s.pledged += uint128(taken);
        _takeIn(payer, taken);
        emit Pledged(_next(), id, backer, payer, taken, weight);

        if (s.pledged == t.target) {
            s.outcome = Outcome.Funded;
            emit Finalized(_next(), id, Outcome.Funded, 0);
        }
    }

    function _payBacker(uint256 id, State storage s, address backer) private returns (uint256 paid, bool ok) {
        Backer storage b = _backers[id][backer];
        if (s.outcome != Outcome.Missed || b.paid || b.principal == 0) return (0, true);
        uint256 bonus = _share(s.bonusPaid, b.weighted, s.weighted);
        paid = uint256(b.principal) + bonus;
        address to = b.payTo == address(0) ? backer : b.payTo;
        b.paid = true;
        totalOwed -= paid;
        if (_send(to, paid)) {
            emit Paid(_next(), id, backer, to, b.principal, bonus);
            return (paid, true);
        }
        b.paid = false;
        totalOwed += paid;
        emit PayFailed(_next(), id, backer, to, paid);
        return (0, false);
    }

    function _sideAmount(Terms storage t, State storage s, Side side) private view returns (uint256) {
        if (side == Side.Recipient) {
            return s.outcome == Outcome.Funded ? uint256(s.pledged) + t.matchAmount : 0;
        }
        if (side == Side.MatchReturn) {
            return (s.outcome != Outcome.Funded && s.matchIn) ? t.matchAmount : 0;
        }
        if (!s.bonusIn) return 0;
        return s.outcome == Outcome.Missed ? t.bonusPool - s.bonusPaid : t.bonusPool;
    }

    /// The bonus early backers split if the campaign is missed:
    /// pledgedEarly x min(bonusPool, rate x weighted) / target. Each side of the minimum is
    /// multiplied out before its one division, which rounds down. The largest product is
    /// 10^15 x 10^4 x 10^21 = 10^40.
    function _bonusFor(Terms storage t, uint256 pledgedEarly, uint256 weighted) private view returns (uint256) {
        uint256 byPool = pledgedEarly * t.bonusPool / t.target;
        uint256 byRate = pledgedEarly * t.rateBps * weighted / (RATE_DIVISOR * t.target);
        return byRate < byPool ? byRate : byPool;
    }

    function _share(uint256 pool, uint256 mine, uint256 all) private pure returns (uint256) {
        return all == 0 ? 0 : pool * mine / all;
    }

    function _weightAt(Terms storage t, uint64 time) private view returns (uint256) {
        if (time < t.opensAt || time >= t.earlyUntil) return 0;
        if (!t.linearWeight) return WEIGHT_ONE;
        return WEIGHT_ONE * (t.earlyUntil - time) / (t.earlyUntil - t.opensAt);
    }

    function _outcomeNow(Terms storage t, State storage s) private view returns (Outcome) {
        if (s.outcome != Outcome.Open) return s.outcome;
        if (block.timestamp >= t.opensAt && !_potsIn(t, s)) return Outcome.Void;
        if (block.timestamp >= t.closesAt) return Outcome.Missed;
        return Outcome.Open;
    }

    function _requirePledgeable(Terms storage t, State storage s) private view {
        if (s.outcome != Outcome.Open) revert OutcomeSet();
        if (block.timestamp < t.opensAt) revert NotOpenYet();
        if (!_potsIn(t, s)) revert CampaignVoid();
        if (block.timestamp >= t.closesAt) revert Closed();
    }

    function _potsIn(Terms storage t, State storage s) private view returns (bool) {
        return (t.matchAmount == 0 || s.matchIn) && (t.bonusPool == 0 || s.bonusIn);
    }

    function _bonusFunder(Terms storage t, State storage s) private view returns (address) {
        return t.bonusFromRecipient ? t.recipient : s.sponsor;
    }

    function _load(uint256 id) private view returns (Terms storage t, State storage s) {
        _exists(id);
        t = _terms[id];
        s = _state[id];
    }

    function _exists(uint256 id) private view {
        if (id == 0 || id > campaignCount) revert NoSuchCampaign();
    }

    function _next() private returns (uint256) {
        return ++eventCount;
    }

    /// Pull exactly `amount` from `from`. The balance must rise by exactly that much.
    function _takeIn(address from, uint256 amount) private {
        uint256 before = usdc.balanceOf(address(this));
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IToken.transferFrom, (from, address(this), amount)));
        if (!ok || !_saidYes(data)) revert TransferFailed();
        if (usdc.balanceOf(address(this)) != before + amount) revert TransferFailed();
        totalOwed += amount;
    }

    /// Send `amount` to `to`. Returns false, and moves nothing, if the token refuses.
    function _send(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeCall(IToken.transfer, (to, amount)));
        return ok && _saidYes(data);
    }

    /// A token call counts as done if it returned nothing or returned true.
    function _saidYes(bytes memory data) private pure returns (bool) {
        return data.length == 0 || (data.length >= 32 && abi.decode(data, (bool)));
    }
}
