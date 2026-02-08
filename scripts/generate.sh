#!/bin/bash
# ==============================================================================
# generate.sh - Generate crypto materials and channel artifacts
# MR Anchor Registry - Two Organization Network
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}MR Anchor Registry - Network Generation${NC}"
echo -e "${GREEN}=============================================${NC}"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
NETWORK_DIR="$PROJECT_DIR/network"

# Paths - all config files are inside the network/ directory
CRYPTO_CONFIG="$NETWORK_DIR/crypto-config.yaml"
CONFIGTX_DIR="$NETWORK_DIR/configtx"
CRYPTO_OUTPUT="$NETWORK_DIR/crypto-config"
CHANNEL_ARTIFACTS="$NETWORK_DIR/channel-artifacts"

# Channel configuration
CHANNEL_NAME="anchorchannel"
PROFILE_GENESIS="TwoOrgsApplicationGenesis"

# Check for fabric binaries
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"
    
    # Check if fabric-samples exists and has binaries
    # fabric-samples should be at the same level as MR-Anchor-Registry
    FABRIC_SAMPLES="${PROJECT_DIR}/../fabric-samples"
    if [ -d "$FABRIC_SAMPLES/bin" ]; then
        export PATH="$FABRIC_SAMPLES/bin:$PATH"
        echo -e "${GREEN}✓ Found fabric-samples binaries at $FABRIC_SAMPLES${NC}"
    else
        echo -e "${RED}✗ fabric-samples/bin not found at $FABRIC_SAMPLES${NC}"
        echo "Please ensure fabric-samples is at the same level as MR-Anchor-Registry:"
        echo "  parent-folder/"
        echo "  ├── fabric-samples/"
        echo "  └── MR-Anchor-Registry/"
        exit 1
    fi
    
    # Verify tools exist
    if ! command -v cryptogen &> /dev/null; then
        echo -e "${RED}✗ cryptogen not found${NC}"
        exit 1
    fi
    
    if ! command -v configtxgen &> /dev/null; then
        echo -e "${RED}✗ configtxgen not found${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ All prerequisites met${NC}"
}

# Clean previous artifacts
clean_artifacts() {
    echo -e "${YELLOW}Cleaning previous artifacts...${NC}"
    
    rm -rf "$CRYPTO_OUTPUT"
    rm -rf "$CHANNEL_ARTIFACTS"
    
    echo -e "${GREEN}✓ Cleaned previous artifacts${NC}"
}

# Generate crypto materials
generate_crypto() {
    echo -e "${YELLOW}Generating crypto materials...${NC}"
    
    mkdir -p "$CRYPTO_OUTPUT"
    
    cryptogen generate --config="$CRYPTO_CONFIG" --output="$CRYPTO_OUTPUT"
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to generate crypto materials${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Generated crypto materials${NC}"
    
    # List generated organizations
    echo -e "${YELLOW}Generated organizations:${NC}"
    ls -la "$CRYPTO_OUTPUT/peerOrganizations/"
    ls -la "$CRYPTO_OUTPUT/ordererOrganizations/"
}

# Generate channel artifacts
generate_channel_artifacts() {
    echo -e "${YELLOW}Generating channel artifacts...${NC}"
    
    mkdir -p "$CHANNEL_ARTIFACTS"
    
    # Set config path
    export FABRIC_CFG_PATH="$CONFIGTX_DIR"
    
    # Generate genesis block for the application channel
    echo -e "${YELLOW}  Creating genesis block for $CHANNEL_NAME...${NC}"
    configtxgen -profile $PROFILE_GENESIS -outputBlock "$CHANNEL_ARTIFACTS/genesis.block" -channelID $CHANNEL_NAME
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to generate genesis block${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}  ✓ Genesis block created${NC}"
    
    # Generate anchor peer updates for Org1
    echo -e "${YELLOW}  Creating Org1 anchor peer update...${NC}"
    configtxgen -profile $PROFILE_GENESIS -outputAnchorPeersUpdate "$CHANNEL_ARTIFACTS/Org1MSPanchors.tx" -channelID $CHANNEL_NAME -asOrg Org1MSP
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to generate Org1 anchor peer update${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}  ✓ Org1 anchor peer update created${NC}"
    
    # Generate anchor peer updates for Org2
    echo -e "${YELLOW}  Creating Org2 anchor peer update...${NC}"
    configtxgen -profile $PROFILE_GENESIS -outputAnchorPeersUpdate "$CHANNEL_ARTIFACTS/Org2MSPanchors.tx" -channelID $CHANNEL_NAME -asOrg Org2MSP
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to generate Org2 anchor peer update${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}  ✓ Org2 anchor peer update created${NC}"
    
    echo -e "${GREEN}✓ All channel artifacts generated${NC}"
    
    # List artifacts
    echo -e "${YELLOW}Generated artifacts:${NC}"
    ls -la "$CHANNEL_ARTIFACTS/"
}

# Generate connection profiles
generate_connection_profiles() {
    echo -e "${YELLOW}Generating connection profiles...${NC}"
    
    mkdir -p "$PROJECT_DIR/gateway/config"
    
    # Org1 connection profile
    cat > "$PROJECT_DIR/gateway/config/connection-org1.json" << EOF
{
    "name": "anchor-registry-org1",
    "version": "1.0.0",
    "client": {
        "organization": "Org1",
        "connection": {
            "timeout": {
                "peer": {
                    "endorser": "300"
                }
            }
        }
    },
    "organizations": {
        "Org1": {
            "mspid": "Org1MSP",
            "peers": ["peer0.org1.anchor-registry.com"],
            "certificateAuthorities": []
        }
    },
    "peers": {
        "peer0.org1.anchor-registry.com": {
            "url": "grpcs://localhost:7051",
            "tlsCACerts": {
                "path": "${CRYPTO_OUTPUT}/peerOrganizations/org1.anchor-registry.com/tlsca/tlsca.org1.anchor-registry.com-cert.pem"
            },
            "grpcOptions": {
                "ssl-target-name-override": "peer0.org1.anchor-registry.com",
                "hostnameOverride": "peer0.org1.anchor-registry.com"
            }
        }
    },
    "orderers": {
        "orderer.anchor-registry.com": {
            "url": "grpcs://localhost:7050",
            "tlsCACerts": {
                "path": "${CRYPTO_OUTPUT}/ordererOrganizations/anchor-registry.com/tlsca/tlsca.anchor-registry.com-cert.pem"
            },
            "grpcOptions": {
                "ssl-target-name-override": "orderer.anchor-registry.com",
                "hostnameOverride": "orderer.anchor-registry.com"
            }
        }
    }
}
EOF
    
    # Org2 connection profile
    cat > "$PROJECT_DIR/gateway/config/connection-org2.json" << EOF
{
    "name": "anchor-registry-org2",
    "version": "1.0.0",
    "client": {
        "organization": "Org2",
        "connection": {
            "timeout": {
                "peer": {
                    "endorser": "300"
                }
            }
        }
    },
    "organizations": {
        "Org2": {
            "mspid": "Org2MSP",
            "peers": ["peer0.org2.anchor-registry.com"],
            "certificateAuthorities": []
        }
    },
    "peers": {
        "peer0.org2.anchor-registry.com": {
            "url": "grpcs://localhost:9051",
            "tlsCACerts": {
                "path": "${CRYPTO_OUTPUT}/peerOrganizations/org2.anchor-registry.com/tlsca/tlsca.org2.anchor-registry.com-cert.pem"
            },
            "grpcOptions": {
                "ssl-target-name-override": "peer0.org2.anchor-registry.com",
                "hostnameOverride": "peer0.org2.anchor-registry.com"
            }
        }
    },
    "orderers": {
        "orderer.anchor-registry.com": {
            "url": "grpcs://localhost:7050",
            "tlsCACerts": {
                "path": "${CRYPTO_OUTPUT}/ordererOrganizations/anchor-registry.com/tlsca/tlsca.anchor-registry.com-cert.pem"
            },
            "grpcOptions": {
                "ssl-target-name-override": "orderer.anchor-registry.com",
                "hostnameOverride": "orderer.anchor-registry.com"
            }
        }
    }
}
EOF
    
    echo -e "${GREEN}✓ Connection profiles generated${NC}"
}

# Main execution
main() {
    check_prerequisites
    clean_artifacts
    generate_crypto
    generate_channel_artifacts
    generate_connection_profiles
    
    echo ""
    echo -e "${GREEN}=============================================${NC}"
    echo -e "${GREEN}Network Generation Complete!${NC}"
    echo -e "${GREEN}=============================================${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Start the network: ./scripts/network.sh up"
    echo "  2. Create channel: ./scripts/channel.sh create"
    echo "  3. Deploy chaincode: ./scripts/chaincode.sh deploy"
}

main "$@"