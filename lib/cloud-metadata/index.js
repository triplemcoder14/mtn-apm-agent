'use strict';
const { getMetadataAws } = require('./aws');
const { getMetadataAzure } = require('./azure');
const { getMetadataGcp } = require('./gcp');
const { CallbackCoordination } = require('./callback-coordination');

const logging = require('../logging');


const CONNECT_TIMEOUT_MS = 100;

const DNS_TIMEOUT_MS = 100;


const HTTP_TIMEOUT_MS = 1000;

// timeout for the CallbackCoordination object -- this is a fallback to
// account for a catastrophic error in the CallbackCoordination object
const COORDINATION_TIMEOUT_MS = 3000;

class CloudMetadata {
  constructor(cloudProvider, logger, serviceName) {
    this.cloudProvider = cloudProvider;
    this.logger = logger;
    this.serviceName = serviceName;
  }

  getCloudMetadata(config, cb) {
    // normalize arguments
    if (!cb) {
      cb = config;
      config = {};
    }

    // fill in blanks if any expected keys are missing
    config.aws = config.aws ? config.aws : null;
    config.azure = config.azure ? config.azure : null;
    config.gcp = config.gcp ? config.gcp : null;

    const fetcher = new CallbackCoordination(
      COORDINATION_TIMEOUT_MS,
      this.logger,
    );

    if (this.shouldFetchGcp()) {
      fetcher.schedule((fetcher) => {
        const url = config.gcp;
        getMetadataGcp(
          CONNECT_TIMEOUT_MS + DNS_TIMEOUT_MS,
          HTTP_TIMEOUT_MS,
          this.logger,
          url,
          (err, result) => {
            fetcher.recordResult(err, result);
          },
        );
      });
    }

    if (this.shouldFetchAws()) {
      fetcher.schedule((fetcher) => {
        const url = config.aws;
        getMetadataAws(
          CONNECT_TIMEOUT_MS,
          HTTP_TIMEOUT_MS,
          this.logger,
          url,
          function (err, result) {
            fetcher.recordResult(err, result);
          },
        );
      });
    }

    if (this.shouldFetchAzure()) {
      fetcher.schedule((fetcher) => {
        const url = config.azure;
        getMetadataAzure(
          CONNECT_TIMEOUT_MS,
          HTTP_TIMEOUT_MS,
          this.logger,
          url,
          function (err, result) {
            fetcher.recordResult(err, result);
          },
        );
      });
    }

    fetcher.on('result', function (result) {
      cb(null, result);
    });

    fetcher.on('error', function (err) {
      cb(err);
    });

    fetcher.start();
  }

  shouldFetchGcp() {
    return this.cloudProvider === 'auto' || this.cloudProvider === 'gcp';
  }

  shouldFetchAzure() {
    return this.cloudProvider === 'auto' || this.cloudProvider === 'azure';
  }

  shouldFetchAws() {
    return this.cloudProvider === 'auto' || this.cloudProvider === 'aws';
  }
}

function main(args) {
  const cloudMetadata = new CloudMetadata('auto', logging.createLogger('off'));
  cloudMetadata.getCloudMetadata(function (err, metadata) {
    if (err) {
      console.log('could not fetch metadata, see error below');
      console.log(err);
      process.exit(1);
    } else {
      console.log('fetched the following metadata');
      console.log(metadata);
      process.exit(0);
    }
  });
}

if (require.main === module) {
  main(process.argv);
}
module.exports = {
  CloudMetadata,
};
