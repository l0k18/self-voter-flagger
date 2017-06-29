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
    var accounts = wait.for(steem_getAccounts_wrapper);
    mAccount = accounts[0];
    console.log("account: "+JSON.stringify(mAccount));
    callback();
  });
}


function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    for (var i = startAtBlockNum; i <= mProperties.head_block_number; i++) {
      var block = wait.for(steem_getBlock_wrapper, i);
      var transactions = block.result.transactions.operations;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        var tName = transaction[0];
        var tDetail = transaction[1];
        console.log("** b " + i + ":t " + j + ", transaction: "+JSON.stringify(transaction));
      }
    }
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

function steem_getBlockHeader_wrapper(num, callback) {
  steem.api.getBlockHeader(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_getBlock_wrapper(num, callback) {
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

function steem_getAccounts_wrapper(callback) {
  steem.api.getAccounts([process.env.STEEM_USER], function(err, result) {
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