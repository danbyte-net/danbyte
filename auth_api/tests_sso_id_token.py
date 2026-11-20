"""OIDC ID token validation (auth_api.sso._validate_id_token) against a real
signature and JWKS, so the code path a login runs is exercised end to end
without a live identity provider."""
from __future__ import annotations

import json
import time
from types import SimpleNamespace
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.test import SimpleTestCase

from . import sso
from .sso import SsoError

ISSUER = "https://idp.example/realms/main"
DOC = {"issuer": ISSUER, "jwks_uri": f"{ISSUER}/certs"}
PROVIDER = SimpleNamespace(oidc_client_id="danbyte")


def _rsa():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk(key, kid, alg="RS256"):
    algo = jwt.algorithms.get_default_algorithms()[alg]
    out = json.loads(algo.to_jwk(key.public_key()))
    out.update(kid=kid, use="sig", alg=alg)
    return out


class IdTokenTests(SimpleTestCase):
    def setUp(self):
        self.key = _rsa()
        self.jwks = {"keys": [_jwk(self.key, "k1")]}

    def _token(self, key=None, alg="RS256", kid="k1", **over):
        now = int(time.time())
        claims = {
            "iss": ISSUER, "aud": "danbyte", "sub": "u1", "nonce": "n1",
            "iat": now, "exp": now + 300,
        }
        claims.update(over)
        claims = {k: v for k, v in claims.items() if v is not None}
        headers = {"kid": kid} if kid else {}
        return jwt.encode(claims, key or self.key, algorithm=alg, headers=headers)

    def _validate(self, token, nonce="n1", jwks=None):
        resp = mock.Mock()
        resp.json.return_value = jwks or self.jwks
        with mock.patch.object(sso.requests, "get", return_value=resp) as get:
            claims = sso._validate_id_token(token, PROVIDER, DOC, nonce)
        get.assert_called_once()
        return claims

    def test_valid_token(self):
        claims = self._validate(self._token())
        self.assertEqual(claims["sub"], "u1")

    def test_key_picked_by_kid(self):
        other = _rsa()
        jwks = {"keys": [_jwk(other, "k0"), _jwk(self.key, "k1")]}
        self.assertEqual(self._validate(self._token(), jwks=jwks)["sub"], "u1")

    def test_single_key_without_kid(self):
        self.assertEqual(self._validate(self._token(kid=None))["sub"], "u1")

    def test_ec_key(self):
        key = ec.generate_private_key(ec.SECP256R1())
        jwks = {"keys": [_jwk(key, "e1", "ES256")]}
        token = self._token(key=key, alg="ES256", kid="e1")
        self.assertEqual(self._validate(token, jwks=jwks)["sub"], "u1")

    def test_key_of_another_type_is_refused(self):
        # RS256 token whose kid names an EC key: a failed login, not a crash.
        ec_key = ec.generate_private_key(ec.SECP256R1())
        jwks = {"keys": [_jwk(ec_key, "e1", "ES256")]}
        with self.assertRaises(SsoError):
            self._validate(self._token(kid="e1"), jwks=jwks)

    def test_jwks_that_is_not_an_object_is_refused(self):
        for bad in (["x"], "x", 7, {"keys": "x"}, {"keys": [7]}, {"keys": [{"kty": "RSA"}]}):
            with self.subTest(jwks=bad), self.assertRaises(SsoError):
                self._validate(self._token(), jwks=bad)

    def test_no_kid_picks_the_key_of_the_tokens_type(self):
        ec_key = ec.generate_private_key(ec.SECP256R1())
        jwks = {"keys": [_jwk(ec_key, "e1", "ES256"), _jwk(self.key, "k1")]}
        self.assertEqual(self._validate(self._token(kid=None), jwks=jwks)["sub"], "u1")
        token = self._token(key=ec_key, alg="ES256", kid=None)
        self.assertEqual(self._validate(token, jwks=jwks)["sub"], "u1")

    def test_no_kid_with_two_keys_of_the_type_is_refused(self):
        jwks = {"keys": [_jwk(_rsa(), "k0"), _jwk(self.key, "k1")]}
        with self.assertRaises(SsoError):
            self._validate(self._token(kid=None), jwks=jwks)

    def test_wrong_signature(self):
        with self.assertRaises(SsoError):
            self._validate(self._token(key=_rsa()))

    def test_unknown_kid(self):
        with self.assertRaisesMessage(SsoError, "signing key not found"):
            self._validate(self._token(kid="nope"))

    def test_hmac_and_none_refused(self):
        for token in (
            jwt.encode({"sub": "u1"}, "secret-secret-secret-secret-secret", algorithm="HS256"),
            jwt.encode({"sub": "u1"}, None, algorithm="none"),
        ):
            with self.assertRaisesMessage(SsoError, "unsupported algorithm"):
                sso._validate_id_token(token, PROVIDER, DOC, "n1")

    def test_expired(self):
        now = int(time.time())
        with self.assertRaises(SsoError):
            self._validate(self._token(iat=now - 900, exp=now - 600))

    def test_small_clock_skew_allowed(self):
        now = int(time.time())
        self.assertEqual(self._validate(self._token(exp=now - 10))["sub"], "u1")

    def test_missing_exp(self):
        with self.assertRaises(SsoError):
            self._validate(self._token(exp=None))

    def test_issuer_mismatch(self):
        with self.assertRaisesMessage(SsoError, "issuer mismatch"):
            self._validate(self._token(iss="https://evil.example"))

    def test_audience_mismatch(self):
        with self.assertRaisesMessage(SsoError, "audience mismatch"):
            self._validate(self._token(aud="other"))

    def test_multiple_audiences_need_azp(self):
        with self.assertRaisesMessage(SsoError, "azp mismatch"):
            self._validate(self._token(aud=["danbyte", "other"]))
        token = self._token(aud=["danbyte", "other"], azp="danbyte")
        self.assertEqual(self._validate(token)["sub"], "u1")

    def test_nonce_mismatch(self):
        with self.assertRaisesMessage(SsoError, "nonce mismatch"):
            self._validate(self._token(nonce="other"))

    def test_garbage_token(self):
        with self.assertRaises(SsoError):
            sso._validate_id_token("not-a-jwt", PROVIDER, DOC, "n1")
