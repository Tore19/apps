// Copyright 2017-2020 @polkadot/react-signer authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { SignerOptions, SignerResult, SubmittableExtrinsic } from '@polkadot/api/types';
import { KeyringPair } from '@polkadot/keyring/types';
import { QueueTx, QueueTxMessageSetStatus, QueueTxStatus } from '@polkadot/react-components/Status/types';
import { Multisig, Timepoint } from '@polkadot/types/interfaces';
import { SignerPayloadJSON } from '@polkadot/types/types';
import { AddressProxy } from './types';

import React, { useCallback, useContext, useEffect, useState } from 'react';
import styled from 'styled-components';
import { SubmittableResult } from '@polkadot/api';
import { web3FromSource } from '@polkadot/extension-dapp';
import { registry } from '@polkadot/react-api';
import { Button, ErrorBoundary, Modal, StatusContext } from '@polkadot/react-components';
import { useApi, useToggle } from '@polkadot/react-hooks';
import { Option } from '@polkadot/types';
import keyring from '@polkadot/ui-keyring';
import { BN_ZERO, assert } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';

import ledgerSigner from '../LedgerSigner';
import { useTranslation } from '../translate';
import Address from './Address';
import Qr from './Qr';
import Tip from './Tip';
import Transaction from './Transaction';
import { extractExternal } from './util';

interface Props {
  className?: string;
  currentItem: QueueTx;
  requestAddress: string;
}

interface QrState {
  isQrHashed: boolean;
  isQrScanning: boolean;
  isQrVisible: boolean;
  qrAddress: string;
  qrPayload: Uint8Array;
  qrResolve?: (result: SignerResult) => void;
  qrReject?: (error: Error) => void;
}

const NOOP = () => undefined;

let qrId = 0;

function unlockAccount (accountId: string, password: string): string | null {
  let publicKey;

  try {
    publicKey = keyring.decodeAddress(accountId);
  } catch (error) {
    console.error(error);

    return 'unable to decode address';
  }

  const pair = keyring.getPair(publicKey);

  try {
    pair.decodePkcs8(password);
  } catch (error) {
    console.error(error);

    return (error as Error).message;
  }

  return null;
}

async function signAndSend (queueSetTxStatus: QueueTxMessageSetStatus, { id, txFailedCb = NOOP, txStartCb = NOOP, txSuccessCb = NOOP, txUpdateCb = NOOP }: QueueTx, tx: SubmittableExtrinsic<'promise'>, pairOrAddress: KeyringPair | string, options: Partial<SignerOptions>): Promise<void> {
  txStartCb();

  try {
    const unsubscribe = await tx.signAndSend(pairOrAddress, options, (result: SubmittableResult): void => {
      if (!result || !result.status) {
        return;
      }

      const status = result.status.type.toLowerCase() as QueueTxStatus;

      console.log('signAndSend: updated status ::', JSON.stringify(result));
      queueSetTxStatus(id, status, result);
      txUpdateCb(result);

      if (result.status.isFinalized || result.status.isInBlock) {
        result.events
          .filter(({ event: { section } }) => section === 'system')
          .forEach(({ event: { method } }): void => {
            if (method === 'ExtrinsicFailed') {
              txFailedCb(result);
            } else if (method === 'ExtrinsicSuccess') {
              txSuccessCb(result);
            }
          });
      } else if (result.isError) {
        txFailedCb(result);
      }

      if (result.isCompleted) {
        unsubscribe();
      }
    });
  } catch (error) {
    console.error('signAndSend: error:', error);
    queueSetTxStatus(id, 'error', {}, error);

    txFailedCb(null);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function signQrPayload (setQrState: (state: QrState) => void): (payload: SignerPayloadJSON) => Promise<SignerResult> {
  return (payload: SignerPayloadJSON): Promise<SignerResult> =>
    new Promise((resolve, reject): void => {
      // limit size of the transaction
      const isQrHashed = (payload.method.length > 5000);
      const wrapper = registry.createType('ExtrinsicPayload', payload, { version: payload.version });
      const qrPayload = isQrHashed
        ? blake2AsU8a(wrapper.toU8a(true))
        : wrapper.toU8a();

      setQrState({
        isQrHashed,
        isQrScanning: false,
        isQrVisible: true,
        qrAddress: payload.address,
        qrPayload,
        qrReject: reject,
        qrResolve: resolve
      });
    });
}

function TxSigned ({ className, currentItem, requestAddress }: Props): React.ReactElement<Props> | null {
  const { api } = useApi();
  const { t } = useTranslation();
  const { queueSetTxStatus } = useContext(StatusContext);
  const [flags, setFlags] = useState(extractExternal(requestAddress));
  const [{ isQrHashed, isQrScanning, isQrVisible, qrAddress, qrPayload }, setQrState] = useState<QrState>({ isQrHashed: false, isQrScanning: false, isQrVisible: false, qrAddress: '', qrPayload: new Uint8Array() });
  const [, toggleRenderError] = useToggle();
  const [isSubmit] = useState(true);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [senderInfo, setSenderInfo] = useState<AddressProxy>({ address: requestAddress, isMultiAddress: false, isMultiCall: false, isProxyAddress: false, password: '' });
  const [tip, setTip] = useState(BN_ZERO);

  useEffect((): void => {
    setFlags(extractExternal(senderInfo.address));
    setPasswordError(null);
  }, [senderInfo]);

  const _onQrSend = useCallback(
    () => setQrState((state) => ({ ...state, isQrScanning: state.isQrVisible, isQrVisible: true })),
    []
  );

  const _addQrSignature = useCallback(
    ({ signature }: { signature: string }): void => {
      setQrState(
        (state): QrState => {
          state.qrResolve &&
            state.qrResolve({
              id: ++qrId,
              signature
            });

          return {
            ...state,
            isQrScanning: false,
            isQrVisible: false
          };
        }
      );
    },
    []
  );

  const _onCancel = useCallback(
    (): void => {
      const { id, signerCb = NOOP, txFailedCb = NOOP } = currentItem;

      queueSetTxStatus(id, 'cancelled');
      signerCb(id, null);
      txFailedCb(null);
    },
    [currentItem, queueSetTxStatus]
  );

  const _onSend = useCallback(
    async (): Promise<void> => {
      const passwordError = senderInfo.address && flags.isUnlockable
        ? unlockAccount(senderInfo.address, senderInfo.password)
        : null;

      if (passwordError || !senderInfo.address) {
        setPasswordError(passwordError);

        return;
      }

      const options: Partial<SignerOptions> = { tip };
      const pair = keyring.getPair(senderInfo.address);
      const submittable = currentItem.extrinsic as SubmittableExtrinsic<'promise'>;
      let tx = submittable;

      if (senderInfo.isMultiAddress) {
        const multiModule = api.tx.multisig ? 'multisig' : 'utility';
        const info = await api.query[multiModule].multisigs<Option<Multisig>>(requestAddress, submittable.method.hash);
        const { threshold, who } = extractExternal(requestAddress);
        const others = who.filter((w) => w !== senderInfo.address);
        let timepoint: Timepoint | null = null;

        if (info.isSome) {
          timepoint = info.unwrap().when;
        }

        tx = senderInfo.isMultiCall
          ? api.tx[multiModule].asMulti.meta.args.length === 5
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            ? api.tx[multiModule].asMulti(threshold, others, timepoint, submittable.method, false)
            : api.tx[multiModule].asMulti(threshold, others, timepoint, submittable.method)
          : api.tx[multiModule].approveAsMulti(threshold, others, timepoint, submittable.method.hash);
      }

      const { meta: { isExternal, isHardware, isInjected, source } } = pair;
      let pairOrAddress: KeyringPair | string = senderInfo.address;

      // set the signer
      if (isHardware) {
        queueSetTxStatus(currentItem.id, 'signing');
        options.signer = ledgerSigner;
      } else if (isExternal) {
        queueSetTxStatus(currentItem.id, 'qr');
        options.signer = { signPayload: signQrPayload(setQrState) };
      } else if (isInjected) {
        const injected = await web3FromSource(source as string);

        assert(injected, `Unable to find a signer for ${senderInfo.address}`);

        queueSetTxStatus(currentItem.id, 'signing');
        options.signer = injected.signer;
      } else {
        queueSetTxStatus(currentItem.id, 'signing');
        pairOrAddress = pair;
      }

      await signAndSend(queueSetTxStatus, currentItem, tx, pairOrAddress, options);
    },
    [api, currentItem, flags, queueSetTxStatus, requestAddress, senderInfo, tip]
  );

  return (
    <>
      <Modal.Content className={className}>
        <ErrorBoundary onError={toggleRenderError}>
          {isQrVisible
            ? (
              <Qr
                address={qrAddress}
                genesisHash={api.genesisHash}
                isHashed={isQrHashed}
                isScanning={isQrScanning}
                onSignature={_addQrSignature}
                payload={qrPayload}
              />
            )
            : (
              <>
                <Transaction
                  currentItem={currentItem}
                  onError={toggleRenderError}
                />
                <Address
                  currentItem={currentItem}
                  onChange={setSenderInfo}
                  passwordError={passwordError}
                  requestAddress={requestAddress}
                />
                <Tip onChange={setTip} />
              </>
            )
          }
        </ErrorBoundary>
      </Modal.Content>
      <Modal.Actions onCancel={_onCancel}>
        <Button
          icon={
            flags.isQr
              ? 'qrcode'
              : 'sign-in'
          }
          isDisabled={!senderInfo.address}
          isPrimary
          label={
            isQrVisible
              ? t<string>('Scan Signature Qr')
              : flags.isQr
                ? t<string>('Sign via Qr')
                : isSubmit
                  ? t<string>('Sign and Submit')
                  : t<string>('Sign (no submission)')
          }
          onClick={isQrVisible ? _onQrSend : _onSend}
          tabIndex={2}
        />
      </Modal.Actions>
    </>
  );
}

export default React.memo(styled(TxSigned)`
  .tipToggle {
    width: 100%;
    text-align: right;
  }

  .ui--Checks {
    margin-top: 0.75rem;
  }
`);