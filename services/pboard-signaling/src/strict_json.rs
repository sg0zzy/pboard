use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::fmt;
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("unambiguous JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Strict(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid_number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Strict, A::Error> {
                let mut out = Vec::new();
                while let Some(Strict(v)) = access.next_element()? {
                    out.push(v);
                }
                Ok(Strict(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Strict, A::Error> {
                let mut out = Map::new();
                while let Some((key, Strict(v))) = access.next_entry::<String, Strict>()? {
                    if out.insert(key, v).is_some() {
                        return Err(de::Error::custom("duplicate_field"));
                    }
                }
                Ok(Strict(Value::Object(out)))
            }
        }
        deserializer.deserialize_any(V)
    }
}
pub fn parse(text: &str) -> Result<Value, &'static str> {
    let Strict(value) = serde_json::from_str(text).map_err(|_| "malformed")?;
    fn bounded(value: &Value, depth: usize) -> bool {
        depth <= 16
            && match value {
                Value::Array(a) => a.iter().all(|v| bounded(v, depth + 1)),
                Value::Object(o) => o.values().all(|v| bounded(v, depth + 1)),
                _ => true,
            }
    }
    if !bounded(&value, 0) {
        return Err("malformed");
    }
    Ok(value)
}
