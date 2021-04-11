import http from 'http'
import httpProxy from 'http-proxy'
import pino from 'pino'
import dotenv from 'dotenv'
import { getDestination } from '@sap-cloud-sdk/core'

import { IHTTPDestinationConfiguration, readConnectivity, readDestination } from 'sap-cf-destconn'
import { basicToJWT, getAuthenticationType, createTokenForDestination } from './authentication'

type IAuthenticationType = "bearer" | "basic" | "none";

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  prettyPrint: process.env.LOG_AS_TEXT !== "false",
})

const proxy = httpProxy.createProxyServer({
    secure: false,
})

const config = {
    proxyport: process.env.PORT || 5050,
    defaultDestination: process.env.DEFAULT_DESTINATION || "SAP_ABAP_BACKEND",
    destinationPropertyName: (process.env.DESTINATION_PROPERTY_NAME || "X-SAP-BTP-destination").toLowerCase(),
    cfproxy: {
        host: process.env.CFPROXY_HOST || '127.0.0.1',
        port: parseInt(process.env.CFPROXY_PORT || "20003")
    },
    credentials: process.env.USER && process.env.PASSWORD ? {
        username: process.env.USER,
        password: process.env.PASSWORD
    } : undefined
};

proxy.on("proxyReq", function (proxyReq, req, res, options) {
    
    //TODO: do we need another way to send the headers to this function?
    //@ts-ignore
    const newHeaders = options.target?.headers || { };

    Object.entries(newHeaders).forEach(
        function([key, value]) {
            proxyReq.setHeader(key, <string>value);
        }
    )
     
});

const server = http.createServer(async (req, res) => {

    const authorization = req.headers.authorization || "";
    const authenticationType = getAuthenticationType(authorization);
    
    let authorizationHeader;
    if (authenticationType === "basic") {
        authorizationHeader = await basicToJWT(authorization);
    }
    if (authenticationType === "bearer") {
        authorizationHeader = authorization;
    }
    if (authenticationType === "none" && config.credentials) {
        authorizationHeader = await basicToJWT(config.credentials);
    }
    
    // read the destination name
    const destinationName = [req.headers[config.destinationPropertyName]].flat()[0] || config.defaultDestination;
    logger.info(`Request entered the building: proxy to ${destinationName}`);

    // read the destination on cloud foundry
    try {
        const sdkDestination = await getDestination(destinationName);
        if(sdkDestination === null) {
            throw Error(`Connection ${destinationName} not found`);
        }
        logger.info(`Forwarding this request to ${sdkDestination.url}`);
        let target: any = new URL(sdkDestination.url);
        target.headers = {
            'host': target.host
        }

        //
        if (sdkDestination.authentication === "OAuth2ClientCredentials") {
            const destination = await readDestination<IHTTPDestinationConfiguration>( destinationName, authorizationHeader )
            const destinationConfiguration = destination.destinationConfiguration;
            const clientCredentialsToken = await createTokenForDestination(destinationConfiguration);
            target.headers = {
                ...target.headers,
                Authorization: `Bearer ${clientCredentialsToken}`
            }
            delete req.headers.authorization;
        }
    
        if (sdkDestination.authTokens && sdkDestination.authTokens[0] && !sdkDestination.authTokens[0].error) {
            if (sdkDestination.authTokens[0].error) {
                throw (new Error(sdkDestination.authTokens[0].error));
            }
            target.headers = {
                ...target.headers,
                Authorization: `${sdkDestination.authTokens[0].type} ${sdkDestination.authTokens[0].value}`
            }
            delete req.headers.authorization;
        }
        //

        if ( sdkDestination.proxyType!.toLowerCase() === "onpremise" ) {
            
            logger.info(`This is an on premise request. Let's send it over the SSH tunnel.`);
            
            const proxy = await (sdkDestination.authentication === "PrincipalPropagation" ?
             readConnectivity(sdkDestination.cloudConnectorLocationId, authorizationHeader) :
             readConnectivity(sdkDestination.cloudConnectorLocationId));
            
            target = {
                path: `${sdkDestination.url}${req.url}`,
                headers: {
                    ...target.headers,
                    ...proxy.headers
                },
                protocol: proxy.proxy.protocol,
                host: config.cfproxy.host,
                port: config.cfproxy.port
            }

            if (sdkDestination.authentication === "PrincipalPropagation") {
                delete req.headers.authorization;
            }

        }

        proxy.web(req, res, { target });
    } catch (error) {
        logger.error(error);
    }
}
);

logger.info(`proxy listening on port     : ${config.proxyport}`);
server.listen(config.proxyport);
