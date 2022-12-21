use std::{borrow::Cow, fmt, mem};

use http::{self, header::HeaderValue, HeaderMap, Method, Request as HttpRequest};
use serde::de::{Deserializer, Error as DeError, MapAccess, Visitor};
use serde_derive::Deserialize;

use crate::body::Body;

/// Representation of a Vercel Lambda proxy event data
#[doc(hidden)]
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VercelRequest<'a> {
    pub(crate) host: Cow<'a, str>,
    pub(crate) path: Cow<'a, str>,
    #[serde(with = "http_serde::method")]
    pub(crate) method: Method,
    #[serde(with = "http_serde::header_map")]
    pub(crate) headers: HeaderMap<HeaderValue>,
    pub(crate) body: Option<Cow<'a, str>>,
    pub(crate) encoding: Option<String>,
}

#[doc(hidden)]
#[derive(Deserialize, Debug, Default)]
pub(crate) struct VercelEvent<'a> {
    #[serde(rename = "Action")]
    action: Cow<'a, str>,
    pub(crate) body: Cow<'a, str>,
}

impl<'a> From<VercelRequest<'a>> for HttpRequest<Body> {
    fn from(value: VercelRequest<'_>) -> Self {
        let VercelRequest {
            host,
            path,
            method,
            headers,
            body,
            encoding,
        } = value;

        // build an http::Request<vercel_lambda::Body> from a vercel_lambda::VercelRequest
        let mut req = HttpRequest::builder()
            .method(method)
            .uri(format!("https://{}{}", host, path))
            .body(match (body, encoding) {
                (Some(ref b), Some(ref encoding)) if encoding == "base64" => {
                    // todo: document failure behavior
                    Body::from(::base64::decode(b.as_ref()).unwrap_or_default())
                }
                (Some(b), _) => Body::from(b.into_owned()),
                _ => Body::from(()),
            })
            .expect("failed to build request");

        // no builder method that sets headers in batch
        let _ = mem::replace(req.headers_mut(), headers);

        req
    }
}
