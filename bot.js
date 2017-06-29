'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for');

const
  DB_RECORDS = "records";

var
  MIN_SP;

var ObjectID = mongodb.ObjectID;
var db;

var mAccount = null;
var mProperties = null;
var mLastInfos = null;


// Connect to the database first
mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  db = database;
  console.log("Database connection ready");

  main();
});

function main() {
  steem.config.set('websocket','wss://steemd.steemit.com');
  init(function () {
    getLastInfos(function () {
      doProcess(mLastInfos.lastBlock, function () {
        console.log("Finished");
      });
    });
  });
}

function init(callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(steem_getSteemGlobaleProperties_wrapper);
    console.log("global properties: "+JSON.stringify(mProperties));
    // get Steem Power of bot account
    var accounts = wait.for(steem_getAccounts_wrapper, process.env.STEEM_USER);
    mAccount = accounts[0];
    console.log("account: "+JSON.stringify(mAccount));
    // set up some vars
    MIN_SP = Number(process.env.MIN_SP);
    callback();
  });
}


function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    var totalVotes = 0;
    var numSelfVotes = 0;
    var numSelfVotesToProcess = 0;
    for (var i = startAtBlockNum; i <= mProperties.head_block_number; i++) {
      var block = wait.for(steem_getBlock_wrapper, i);
      //console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0 ; k < transaction.operations.length ; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          try {
            if (opName !== undefined && opName !== null
              && opName.localeCompare("vote") == 0) {

              totalVotes++;

              // check vote is a self vote
              if (opDetail.voter.localeCompare(opDetail.author) != 0) {
                continue;
              }
              numSelfVotes++;

              console.log("- self vote at b " + i + ":t " + j + ":op " +
                k + ", detail:" + JSON.stringify(opDetail));

              // FIRST THINGS FIRST, check their SP
              // TODO : cache user accounts
              var accounts = wait.for(steem_getAccounts_wrapper, opDetail.voter);
              var voterAccount = accounts[0];
              // TODO : take delegated stake into consideration?
              var steemPower = getSteemPowerFromVest(voterAccount.vesting_shares);
              if (steemPower < MIN_SP) {
                console.log("SP of "+opDetail.voter+" < min of "+MIN_SP
                  +", skipping");
                continue;
              }

              // SECOND, get rshares of vote from post
              var content;
              // TODO : cache posts
              content = wait.for(steem_getContent_wrapper, opDetail.author,
                opDetail.permlink);
              if (content === undefined || content === null) {
                console.log("Couldn't process operation, continuing." +
                  " Error: post content response not defined");
                continue;
              }
              var voteDetail = null;
              for (var m = 0; m < content.active_votes.length; m++) {
                if (content.active_votes[m].voter.localeCompare(opDetail.voter) == 0) {
                  voteDetail = content.active_votes[m];
                  break;
                }
              }
              if (voteDetail === null) {
                continue;
              }

              numSelfVotesToProcess++;

              var abs_need_rshares = Math.abs(voteDetail.rshares);
              var vp = recalcVotingPower();
              // note, these constants are not fully understoof
              // the _50_ constant was 200, and could possibly be better at 40
              // TODO : confirm constants are correct
              // TODO : take delegated stake into consideration?
              var abs_percentage = (abs_need_rshares * 10000 * 100 * 50 / vp / mAccount.vesting_shares);
              if (abs_percentage > 100) {
                abs_percentage = 100;
              }
              var percentage = abs_percentage;
              if (voteDetail.rshares < 0) {
                percentage = -percentage;
              }
              console.log("countering percentage: "+percentage);
              if (process.env.ACTIVE !== undefined
                && process.env.ACTIVE !== null
                && process.env.ACTIVE.localeCompare("true") == 0) {
                // TODO : cast vote!
                console.log("BOT WOULD VOTE NOW");
              } else {
                console.log("Bot not in active state, not voting");
              }
            }
          } catch (err) {
            console.log("Couldn't process operation, continuing. Error: "
              + JSON.stringify(err));
            continue;
          }
        }
      }
    }
    console.log("NUM SELF VOTES from block "+startAtBlockNum+" to " +
      mProperties.head_block_number + " is "+numSelfVotes +
      "("+numSelfVotesToProcess+" processed) out of " + totalVotes + " total");
    mLastInfos.lastBlock = mProperties.head_block_number;
    wait.for(mongoSave_wrapper, mLastInfos);
    callback();
  });
}

function getLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err || data === null || data === undefined || data.length === 0) {
      console.log("No last infos data in db, is first time run, set up" +
        " with defaults");
      if (process.env.STARTING_BLOCK_NUM !== undefined
        && process.env.STARTING_BLOCK_NUM !== null) {
        mLastInfos = {
          lastBlock: Number(process.env.STARTING_BLOCK_NUM)
        };
      } else {
        mLastInfos = {
          lastBlock: 0
        };
      }
    } else {
      mLastInfos = data[0];
    }
    callback();
  });
}

function recalcVotingPower(latestBlockTimestamp) {
  // update account
  var accounts = wait.for(steem_getAccounts_wrapper, process.env.STEEM_USER);
  mAccount = accounts[0];
  var vp = mAccount.voting_power;
  //last_vote_time = Time.parse(r["last_vote_time"] + 'Z')
  var lastVoteTime = moment(mAccount.last_vote_time);
  //now_time = Time.parse(@latest_block["timestamp"] + 'Z')
  var nowTime = moment(latestBlockTimestamp);
  var secondsDiff = nowTime.seconds() - lastVoteTime.seconds();
  var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
  vp += vpRegenerated;
  if (vp > 10000) {
    vp = 10000;
  }
  return vp;
}

/*
 getSteemPowerFromVest(vest):
 * converts vesting steem (from get user query) to Steem Power (as on Steemit.com website)
 */
function getSteemPowerFromVest(vest) {
  try {
    return steem.formatter.vestToSteem(
      vest,
      parseFloat(mProperties.total_vesting_shares),
      parseFloat(mProperties.total_vesting_fund_steem)
    );
  } catch(err) {
    return 0;
  }
}

function steem_getBlockHeader_wrapper(blockNum, callback) {
  steem.api.getBlockHeader(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_getBlock_wrapper(blockNum, callback) {
  steem.api.getBlock(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_getDiscussionsByCreated_wrapper(query, callback) {
  steem.api.getDiscussionsByCreated(query, function (err, result) {
    callback(err, result);
  });
}

function steem_getSteemGlobaleProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
  });
}

function steem_getAccounts_wrapper(author, callback) {
  steem.api.getAccounts([author], function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountCount_wrapper(callback) {
  steem.api.getAccountCount(function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountHistory_wrapper(start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function steem_getContent_wrapper(author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}


function mongoSave_wrapper(obj, callback) {
  db.collection(DB_RECORDS).save(obj, function (err, data) {
    callback(err, data);
  });
}